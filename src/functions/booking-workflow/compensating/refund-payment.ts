import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const logger = new Logger({ serviceName: 'refund-payment' });
const tracer = new Tracer({ serviceName: 'refund-payment' });

const eb = tracer.captureAWSv3Client(new EventBridgeClient({}));

interface RefundPaymentInput {
  bookingId: string;
  paymentId?: string;
  totalPrice?: number;
  [key: string]: unknown;
}

export const handler = async (input: RefundPaymentInput): Promise<RefundPaymentInput> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('refundPayment');

  try {
    logger.info('Processing payment refund (saga compensation)', {
      bookingId: input.bookingId,
      paymentId: input.paymentId,
    });

    if (input.paymentId) {
      // Mock Stripe refund — replace with real Stripe SDK call in production
      // await stripe.refunds.create({ charge: input.paymentId });
      logger.info('Payment refunded (mock)', { paymentId: input.paymentId, amount: input.totalPrice });
    } else {
      logger.info('No paymentId present, skipping refund (payment was not captured)');
    }

    await eb.send(new PutEventsCommand({
      Entries: [{
        EventBusName: process.env.EVENT_BUS_NAME!,
        Source: 'booking.workflow',
        DetailType: 'PaymentRefunded',
        Detail: JSON.stringify({
          bookingId: input.bookingId,
          paymentId: input.paymentId ?? null,
          totalPrice: input.totalPrice ?? 0,
        }),
      }],
    }));

    return input;
  } catch (err) {
    logger.error('Error processing refund', { error: err });
    throw err;
  } finally {
    subsegment?.close();
  }
};
