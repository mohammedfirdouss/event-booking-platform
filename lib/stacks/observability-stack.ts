import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { BookingStack } from './booking-stack';
import { ApiStack } from './api-stack';
import { EventsStack } from './events-stack';

export interface ObservabilityStackProps extends cdk.StackProps {
  envName: string;
  bookingStack: BookingStack;
  apiStack: ApiStack;
  eventsStack: EventsStack;
}

export class ObservabilityStack extends cdk.Stack {
  public readonly sfExecutionFailuresAlarm: cloudwatch.Alarm;
  public readonly paymentFailureAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { envName, bookingStack, apiStack, eventsStack } = props;

    // ── Custom metric definitions ─────────────────────────────────────────
    const bookingAttemptsMetric = new cloudwatch.Metric({
      namespace: 'AirlineBooking',
      metricName: 'BookingAttempts',
      dimensionsMap: { Environment: envName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const bookingSuccessMetric = new cloudwatch.Metric({
      namespace: 'AirlineBooking',
      metricName: 'BookingSuccessRate',
      dimensionsMap: { Environment: envName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const paymentFailuresMetric = new cloudwatch.Metric({
      namespace: 'AirlineBooking',
      metricName: 'PaymentFailures',
      dimensionsMap: { Environment: envName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const loyaltyPointsMetric = new cloudwatch.Metric({
      namespace: 'AirlineBooking',
      metricName: 'LoyaltyPointsAwarded',
      dimensionsMap: { Environment: envName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    // ── Step Functions metrics ────────────────────────────────────────────
    const sfExecutionsFailed = new cloudwatch.Metric({
      namespace: 'AWS/States',
      metricName: 'ExecutionsFailed',
      dimensionsMap: {
        StateMachineArn: bookingStack.stateMachine.stateMachineArn,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });

    const sfExecutionsSucceeded = new cloudwatch.Metric({
      namespace: 'AWS/States',
      metricName: 'ExecutionsSucceeded',
      dimensionsMap: {
        StateMachineArn: bookingStack.stateMachine.stateMachineArn,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    // ── AppSync metrics ───────────────────────────────────────────────────
    const appsync4xx = new cloudwatch.Metric({
      namespace: 'AWS/AppSync',
      metricName: '4XXError',
      dimensionsMap: { GraphQLAPIId: apiStack.api.apiId },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const appsync5xx = new cloudwatch.Metric({
      namespace: 'AWS/AppSync',
      metricName: '5XXError',
      dimensionsMap: { GraphQLAPIId: apiStack.api.apiId },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    // ── Alarms ────────────────────────────────────────────────────────────
    const alarmAction = new actions.SnsAction(eventsStack.alertTopic);

    this.sfExecutionFailuresAlarm = new cloudwatch.Alarm(this, 'SFExecutionFailuresAlarm', {
      alarmName: `airline-sf-failures-${envName}`,
      alarmDescription: 'Step Functions booking workflow execution failures exceed threshold',
      metric: sfExecutionsFailed,
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.sfExecutionFailuresAlarm.addAlarmAction(alarmAction);

    this.paymentFailureAlarm = new cloudwatch.Alarm(this, 'PaymentFailureAlarm', {
      alarmName: `airline-payment-failures-${envName}`,
      alarmDescription: 'Payment failure rate exceeds threshold',
      metric: paymentFailuresMetric,
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.paymentFailureAlarm.addAlarmAction(alarmAction);

    // ── CloudWatch Dashboard ──────────────────────────────────────────────
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `AirlineBooking-${envName}`,
      defaultInterval: cdk.Duration.hours(3),
    });

    // Row 1: Booking success funnel
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Booking Attempts vs Success Rate',
        left: [bookingAttemptsMetric],
        right: [bookingSuccessMetric],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Payment Failures',
        left: [paymentFailuresMetric],
        width: 12,
        height: 6,
      }),
    );

    // Row 2: Step Functions
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Step Functions Executions',
        left: [sfExecutionsFailed],
        right: [sfExecutionsSucceeded],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Loyalty Points Awarded',
        left: [loyaltyPointsMetric],
        width: 12,
        height: 6,
      }),
    );

    // Row 3: AppSync errors
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'AppSync Errors',
        left: [appsync4xx, appsync5xx],
        width: 12,
        height: 6,
      }),
      new cloudwatch.AlarmWidget({
        title: 'Active Alarms',
        alarm: this.sfExecutionFailuresAlarm,
        width: 12,
        height: 6,
      }),
    );

    new cdk.CfnOutput(this, 'DashboardName', { value: dashboard.dashboardName });
    new cdk.CfnOutput(this, 'SFFailuresAlarmArn', { value: this.sfExecutionFailuresAlarm.alarmArn });
    new cdk.CfnOutput(this, 'PaymentFailureAlarmArn', { value: this.paymentFailureAlarm.alarmArn });
  }
}
