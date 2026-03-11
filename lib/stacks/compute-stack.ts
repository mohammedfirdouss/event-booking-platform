import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { BookingStack } from './booking-stack';
import { ObservabilityStack } from './observability-stack';

export interface ComputeStackProps extends cdk.StackProps {
  envName: string;
  bookingStack: BookingStack;
  observabilityStack: ObservabilityStack;
}

interface ManagedFunction {
  fn: lambda.Function;
  name: string;
}

export class ComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { envName, bookingStack, observabilityStack } = props;

    const managedFunctions: ManagedFunction[] = [
      { fn: bookingStack.reserveSeatFn, name: 'reserve-seat' },
      { fn: bookingStack.processPaymentFn, name: 'process-payment' },
      { fn: bookingStack.confirmBookingFn, name: 'confirm-booking' },
      { fn: bookingStack.sendNotificationFn, name: 'send-notification' },
    ];

    for (const { fn, name } of managedFunctions) {
      // Create version + live alias
      const version = fn.currentVersion;
      const alias = new lambda.Alias(this, `${name}-alias`, {
        aliasName: 'live',
        version,
      });

      // Pre-traffic hook: smoke test with synthetic event
      const preHook = new lambda.Function(this, `${name}-pre-hook`, {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline(`
          const { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand } = require('@aws-sdk/client-codedeploy');
          const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

          exports.handler = async (event) => {
            const codedeploy = new CodeDeployClient({});
            const lambdaClient = new LambdaClient({});
            const { DeploymentId, LifecycleEventHookExecutionId, FunctionToTest } = event;

            let status = 'Succeeded';
            try {
              const resp = await lambdaClient.send(new InvokeCommand({
                FunctionName: FunctionToTest,
                Payload: JSON.stringify({ source: 'pre-traffic-hook' }),
              }));
              if (resp.FunctionError) status = 'Failed';
            } catch (err) {
              console.error('Pre-hook error:', err);
              status = 'Failed';
            }

            await codedeploy.send(new PutLifecycleEventHookExecutionStatusCommand({
              deploymentId: DeploymentId,
              lifecycleEventHookExecutionId: LifecycleEventHookExecutionId,
              status,
            }));
          };
        `),
        environment: { FunctionToTest: alias.functionArn },
        timeout: cdk.Duration.minutes(1),
      });

      alias.grantInvoke(preHook);
      preHook.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
        actions: ['codedeploy:PutLifecycleEventHookExecutionStatus'],
        resources: ['*'],
      }));

      // Post-traffic hook: check CloudWatch for errors
      const postHook = new lambda.Function(this, `${name}-post-hook`, {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline(`
          const { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand } = require('@aws-sdk/client-codedeploy');
          const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');

          exports.handler = async (event) => {
            const codedeploy = new CodeDeployClient({});
            const cw = new CloudWatchClient({});
            const { DeploymentId, LifecycleEventHookExecutionId } = event;

            let status = 'Succeeded';
            const endTime = new Date();
            const startTime = new Date(endTime.getTime() - 5 * 60 * 1000);

            try {
              const resp = await cw.send(new GetMetricStatisticsCommand({
                Namespace: 'AWS/Lambda',
                MetricName: 'Errors',
                Dimensions: [{ Name: 'FunctionName', Value: process.env.FUNCTION_NAME }],
                StartTime: startTime,
                EndTime: endTime,
                Period: 300,
                Statistics: ['Sum'],
              }));
              const errorCount = resp.Datapoints?.reduce((sum, dp) => sum + (dp.Sum ?? 0), 0) ?? 0;
              if (errorCount > 5) status = 'Failed';
            } catch (err) {
              console.error('Post-hook error:', err);
            }

            await codedeploy.send(new PutLifecycleEventHookExecutionStatusCommand({
              deploymentId: DeploymentId,
              lifecycleEventHookExecutionId: LifecycleEventHookExecutionId,
              status,
            }));
          };
        `),
        environment: { FUNCTION_NAME: fn.functionName },
        timeout: cdk.Duration.minutes(1),
      });

      postHook.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
        actions: [
          'codedeploy:PutLifecycleEventHookExecutionStatus',
          'cloudwatch:GetMetricStatistics',
        ],
        resources: ['*'],
      }));

      // CodeDeploy deployment group
      const application = new codedeploy.LambdaApplication(this, `${name}-app`, {
        applicationName: `airline-${name}-${envName}`,
      });

      new codedeploy.LambdaDeploymentGroup(this, `${name}-dg`, {
        application,
        alias,
        deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
        preHook,
        postHook,
        alarms: [observabilityStack.paymentFailureAlarm],
      });

      new cdk.CfnOutput(this, `${name}-alias-arn`, {
        value: alias.functionArn,
        exportName: `airline-${name}-live-arn-${envName}`,
      });
    }
  }
}
