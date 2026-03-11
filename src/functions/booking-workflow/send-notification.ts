import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const logger = new Logger({ serviceName: 'send-notification' });
const tracer = new Tracer({ serviceName: 'send-notification' });

const sns = tracer.captureAWSv3Client(new SNSClient({}));
const eb = tracer.captureAWSv3Client(new EventBridgeClient({}));

interface SendNotificationInput {
  bookingId: string;
  userId: string;
  flightId: string;
  seats: number;
  totalPrice: number;
  confirmedAt: string;
  paymentId: string;
}

export const handler = async (input: SendNotificationInput): Promise<SendNotificationInput> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('sendNotification');

  // Best-effort: never throw — a notification failure should not roll back the booking
  try {
    logger.info('Sending booking confirmation notification', { bookingId: input.bookingId });

    const topicArn = process.env.ALERT_TOPIC_ARN;

    if (topicArn) {
      await sns.send(new PublishCommand({
        TopicArn: topicArn,
        Subject: `Booking Confirmed: ${input.bookingId}`,
        Message: JSON.stringify({
          message: 'Your airline booking has been confirmed!',
          bookingId: input.bookingId,
          flightId: input.flightId,
          seats: input.seats,
          totalPrice: input.totalPrice,
          confirmedAt: input.confirmedAt,
        }),
      }));
    }

    await eb.send(new PutEventsCommand({
      Entries: [{
        EventBusName: process.env.EVENT_BUS_NAME!,
        Source: 'booking.workflow',
        DetailType: 'NotificationSent',
        Detail: JSON.stringify({ bookingId: input.bookingId }),
      }],
    }));

    logger.info('Notification sent', { bookingId: input.bookingId });
  } catch (err) {
    // Best-effort: log but do not rethrow
    logger.warn('Notification failed (best-effort, continuing)', { error: err });
  } finally {
    subsegment?.close();
  }

  return input;
};
