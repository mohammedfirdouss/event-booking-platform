import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export interface EventsStackProps extends cdk.StackProps {
  envName: string;
  alertEmail?: string;
}

export class EventsStack extends cdk.Stack {
  public readonly eventBus: events.EventBus;
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: EventsStackProps) {
    super(scope, id, props);

    const { envName, alertEmail } = props;

    this.eventBus = new events.EventBus(this, 'BookingBus', {
      eventBusName: `airline-booking-bus-${envName}`,
    });

    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `airline-alerts-${envName}`,
      displayName: 'Airline Booking Alerts',
    });

    if (alertEmail) {
      this.alertTopic.addSubscription(
        new subscriptions.EmailSubscription(alertEmail)
      );
    }

    // Audit log group — captures ALL booking events
    const auditLogGroup = new logs.LogGroup(this, 'BookingEventsLog', {
      logGroupName: `/airline/booking-events-${envName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new events.Rule(this, 'AuditRule', {
      eventBus: this.eventBus,
      ruleName: `airline-audit-all-${envName}`,
      description: 'Captures all booking.workflow events for audit',
      eventPattern: {
        source: ['booking.workflow'],
      },
      targets: [new targets.CloudWatchLogGroup(auditLogGroup)],
    });

    // Notification rule — BookingFailed → SNS
    new events.Rule(this, 'NotificationRule', {
      eventBus: this.eventBus,
      ruleName: `airline-booking-failed-${envName}`,
      description: 'Routes BookingFailed events to SNS alert topic',
      eventPattern: {
        source: ['booking.workflow'],
        detailType: ['BookingFailed'],
      },
      targets: [new targets.SnsTopic(this.alertTopic)],
    });

    new cdk.CfnOutput(this, 'EventBusName', { value: this.eventBus.eventBusName });
    new cdk.CfnOutput(this, 'EventBusArn', { value: this.eventBus.eventBusArn });
    new cdk.CfnOutput(this, 'AlertTopicArn', { value: this.alertTopic.topicArn });
  }
}
