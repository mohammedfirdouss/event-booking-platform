import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface SagaStep {
  name: string;
  lambdaFunction: lambda.IFunction;
  compensationFunction?: lambda.IFunction;
}

export interface SagaStateMachineProps {
  steps: SagaStep[];
  stateMachineName: string;
  timeout?: cdk.Duration;
}

/**
 * L3 construct: builds a saga-pattern Step Functions state machine
 * where each step has an optional compensating transaction.
 * On failure, the machine walks backwards through compensating steps.
 */
export class SagaStateMachine extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: SagaStateMachineProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      logGroupName: `/aws/states/${props.stateMachineName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const failState = new sfn.Fail(this, 'BookingFailed', {
      comment: 'Booking workflow failed after compensation',
    });

    const succeedState = new sfn.Succeed(this, 'BookingSucceeded', {
      comment: 'Booking workflow completed successfully',
    });

    // Build compensation chain (in reverse order)
    let compensationChain: sfn.IChainable = failState;
    for (let i = props.steps.length - 1; i >= 0; i--) {
      const step = props.steps[i];
      if (step.compensationFunction) {
        const compensationTask = new tasks.LambdaInvoke(this, `${step.name}Compensate`, {
          lambdaFunction: step.compensationFunction,
          outputPath: '$.Payload',
          retryOnServiceExceptions: false,
        });
        compensationTask.next(compensationChain);
        compensationChain = compensationTask;
      }
    }

    // Build forward chain (in order)
    let chain: sfn.IChainable = succeedState;
    for (let i = props.steps.length - 1; i >= 0; i--) {
      const step = props.steps[i];
      const task = new tasks.LambdaInvoke(this, step.name, {
        lambdaFunction: step.lambdaFunction,
        outputPath: '$.Payload',
      });

      // Build compensation chain up to this point (steps i+1..n-1 need compensation)
      let localCompensation: sfn.IChainable = failState;
      for (let j = i - 1; j >= 0; j--) {
        const prevStep = props.steps[j];
        if (prevStep.compensationFunction) {
          const compTask = new tasks.LambdaInvoke(this, `${prevStep.name}CompensateFrom${step.name}`, {
            lambdaFunction: prevStep.compensationFunction,
            outputPath: '$.Payload',
            retryOnServiceExceptions: false,
          });
          compTask.next(localCompensation);
          localCompensation = compTask;
        }
      }

      task.addCatch(localCompensation, {
        errors: ['States.ALL'],
        resultPath: '$.error',
      });
      task.next(chain);
      chain = task;
    }

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: props.stateMachineName,
      definitionBody: sfn.DefinitionBody.fromChainable(chain),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: props.timeout ?? cdk.Duration.minutes(5),
      tracingEnabled: true,
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });
  }
}
