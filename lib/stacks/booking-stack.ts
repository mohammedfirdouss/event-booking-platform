import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { PoweredLambda } from '../constructs/powered-lambda';
import { DataStack } from './data-stack';
import { EventsStack } from './events-stack';

export interface BookingStackProps extends cdk.StackProps {
  envName: string;
  dataStack: DataStack;
  eventsStack: EventsStack;
}

export class BookingStack extends cdk.Stack {
  public readonly stateMachine: sfn.StateMachine;
  public readonly reserveSeatFn: lambda.Function;
  public readonly processPaymentFn: lambda.Function;
  public readonly confirmBookingFn: lambda.Function;
  public readonly sendNotificationFn: lambda.Function;
  public readonly releaseSeatFn: lambda.Function;
  public readonly refundPaymentFn: lambda.Function;
  public readonly cancelBookingFn: lambda.Function;

  constructor(scope: Construct, id: string, props: BookingStackProps) {
    super(scope, id, props);

    const { envName, dataStack, eventsStack } = props;

    const commonEnv = {
      FLIGHTS_TABLE: dataStack.flightsTable.tableName,
      BOOKINGS_TABLE: dataStack.bookingsTable.tableName,
      LOYALTY_TABLE: dataStack.loyaltyTable.tableName,
      EVENT_BUS_NAME: eventsStack.eventBus.eventBusName,
    };

    // ── Forward task Lambdas ──────────────────────────────────────────────
    this.reserveSeatFn = new PoweredLambda(this, 'ReserveSeat', {
      functionPath: 'booking-workflow/reserve-seat.ts',
      serviceName: 'reserve-seat',
      environment: commonEnv,
    });

    this.processPaymentFn = new PoweredLambda(this, 'ProcessPayment', {
      functionPath: 'booking-workflow/process-payment.ts',
      serviceName: 'process-payment',
      environment: commonEnv,
    });

    this.confirmBookingFn = new PoweredLambda(this, 'ConfirmBooking', {
      functionPath: 'booking-workflow/confirm-booking.ts',
      serviceName: 'confirm-booking',
      environment: commonEnv,
    });

    this.sendNotificationFn = new PoweredLambda(this, 'SendNotification', {
      functionPath: 'booking-workflow/send-notification.ts',
      serviceName: 'send-notification',
      environment: {
        ...commonEnv,
        ALERT_TOPIC_ARN: eventsStack.alertTopic.topicArn,
      },
    });

    // ── Compensating (rollback) Lambdas ───────────────────────────────────
    this.releaseSeatFn = new PoweredLambda(this, 'ReleaseSeat', {
      functionPath: 'booking-workflow/compensating/release-seat.ts',
      serviceName: 'release-seat',
      environment: commonEnv,
    });

    this.refundPaymentFn = new PoweredLambda(this, 'RefundPayment', {
      functionPath: 'booking-workflow/compensating/refund-payment.ts',
      serviceName: 'refund-payment',
      environment: commonEnv,
    });

    this.cancelBookingFn = new PoweredLambda(this, 'CancelBooking', {
      functionPath: 'booking-workflow/compensating/cancel-booking.ts',
      serviceName: 'cancel-booking',
      environment: commonEnv,
    });

    // ── Grant DynamoDB permissions ────────────────────────────────────────
    const allFunctions = [
      this.reserveSeatFn, this.processPaymentFn, this.confirmBookingFn,
      this.sendNotificationFn, this.releaseSeatFn, this.refundPaymentFn,
      this.cancelBookingFn,
    ];

    for (const fn of allFunctions) {
      dataStack.flightsTable.grantReadWriteData(fn);
      dataStack.bookingsTable.grantReadWriteData(fn);
      dataStack.loyaltyTable.grantReadWriteData(fn);
      eventsStack.eventBus.grantPutEventsTo(fn);
    }

    eventsStack.alertTopic.grantPublish(this.sendNotificationFn);

    // ── Step Functions state machine definition ───────────────────────────
    const logGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      logGroupName: `/aws/states/airline-booking-${envName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Leaf fail/succeed states
    const bookingFailed = new sfn.Fail(this, 'BookingFailed', {
      comment: 'Booking workflow failed after compensation',
    });

    const bookingSucceeded = new sfn.Succeed(this, 'BookingSucceeded');

    // Compensating tasks
    const releaseSeatTask = new tasks.LambdaInvoke(this, 'ReleaseSeatTask', {
      lambdaFunction: this.releaseSeatFn,
      outputPath: '$.Payload',
    });

    const refundPaymentTask = new tasks.LambdaInvoke(this, 'RefundPaymentTask', {
      lambdaFunction: this.refundPaymentFn,
      outputPath: '$.Payload',
    });

    const cancelBookingTask = new tasks.LambdaInvoke(this, 'CancelBookingTask', {
      lambdaFunction: this.cancelBookingFn,
      outputPath: '$.Payload',
    });

    // Compensation chains
    // After ReserveSeat failure: just fail
    releaseSeatTask.next(bookingFailed);

    // After ProcessPayment failure: releaseSeat → fail
    const releaseSeatOnly = new tasks.LambdaInvoke(this, 'ReleaseSeatAfterPayment', {
      lambdaFunction: this.releaseSeatFn,
      outputPath: '$.Payload',
    });
    releaseSeatOnly.next(bookingFailed);

    // After ProcessPayment failure: release + fail
    refundPaymentTask.next(bookingFailed);
    const releaseAndRefund = new tasks.LambdaInvoke(this, 'ReleaseSeatForRefund', {
      lambdaFunction: this.releaseSeatFn,
      outputPath: '$.Payload',
    });
    releaseAndRefund.next(refundPaymentTask);

    // After ConfirmBooking failure: cancel → release → refund → fail
    const cancelThenRelease = new tasks.LambdaInvoke(this, 'CancelBookingCompensate', {
      lambdaFunction: this.cancelBookingFn,
      outputPath: '$.Payload',
    });
    const releaseSeatAfterCancel = new tasks.LambdaInvoke(this, 'ReleaseSeatAfterCancel', {
      lambdaFunction: this.releaseSeatFn,
      outputPath: '$.Payload',
    });
    const refundAfterCancel = new tasks.LambdaInvoke(this, 'RefundAfterCancel', {
      lambdaFunction: this.refundPaymentFn,
      outputPath: '$.Payload',
    });
    cancelThenRelease.next(releaseSeatAfterCancel);
    releaseSeatAfterCancel.next(refundAfterCancel);
    refundAfterCancel.next(bookingFailed);

    // Forward tasks
    const sendNotificationTask = new tasks.LambdaInvoke(this, 'SendNotificationTask', {
      lambdaFunction: this.sendNotificationFn,
      outputPath: '$.Payload',
    });
    sendNotificationTask.next(bookingSucceeded);

    const confirmBookingTask = new tasks.LambdaInvoke(this, 'ConfirmBookingTask', {
      lambdaFunction: this.confirmBookingFn,
      outputPath: '$.Payload',
    });
    confirmBookingTask.addCatch(cancelThenRelease, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });
    confirmBookingTask.next(sendNotificationTask);

    const processPaymentTask = new tasks.LambdaInvoke(this, 'ProcessPaymentTask', {
      lambdaFunction: this.processPaymentFn,
      outputPath: '$.Payload',
    });
    processPaymentTask.addCatch(releaseAndRefund, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });
    processPaymentTask.next(confirmBookingTask);

    const reserveSeatTask = new tasks.LambdaInvoke(this, 'ReserveSeatTask', {
      lambdaFunction: this.reserveSeatFn,
      outputPath: '$.Payload',
    });
    reserveSeatTask.addCatch(releaseSeatTask, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });
    reserveSeatTask.next(processPaymentTask);

    this.stateMachine = new sfn.StateMachine(this, 'BookingStateMachine', {
      stateMachineName: `airline-booking-workflow-${envName}`,
      definitionBody: sfn.DefinitionBody.fromChainable(reserveSeatTask),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(5),
      tracingEnabled: true,
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    new cdk.CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.stateMachineArn });
  }
}
