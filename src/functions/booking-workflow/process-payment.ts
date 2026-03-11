import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';

const logger = new Logger({ serviceName: 'process-payment' });
const tracer = new Tracer({ serviceName: 'process-payment' });
const metrics = new Metrics({ namespace: 'AirlineBooking', serviceName: 'process-payment' });

const eb = tracer.captureAWSv3Client(new EventBridgeClient({}));

interface ProcessPaymentInput {
  bookingId: string;
  userId: string;
  flightId: string;
  seats: number;
  paymentToken: string;
  totalPrice: number;
  reservationTimestamp: string;
}

interface ProcessPaymentOutput extends ProcessPaymentInput {
  paymentId: string;
  paymentTimestamp: string;
}

export const handler = async (input: ProcessPaymentInput): Promise<ProcessPaymentOutput> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('processPayment');

  try {
    // Allow testing failure path via env var
    if (process.env.FORCE_PAYMENT_FAILURE === 'true') {
      throw new Error('Payment forced to fail for testing');
    }

    logger.info('Processing payment', {
      bookingId: input.bookingId,
      totalPrice: input.totalPrice,
      paymentToken: input.paymentToken.slice(0, 8) + '...',
    });

    // Mock Stripe charge — replace with real Stripe SDK call in production
    const paymentId = `pay_${randomUUID().replace(/-/g, '')}`;

    // Simulate occasional payment gateway timeouts
    const shouldSimulateDelay = Math.random() < 0.05;
    if (shouldSimulateDelay) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Mock validation: reject test tokens that indicate failure
    if (input.paymentToken === 'tok_fail' || input.paymentToken.startsWith('fail_')) {
      metrics.addMetric('PaymentFailures', MetricUnit.Count, 1);
      throw new Error(`Payment declined for token ${input.paymentToken}`);
    }

    const paymentTimestamp = new Date().toISOString();

    // Emit PaymentProcessed event
    await eb.send(new PutEventsCommand({
      Entries: [{
        EventBusName: process.env.EVENT_BUS_NAME!,
        Source: 'booking.workflow',
        DetailType: 'PaymentProcessed',
        Detail: JSON.stringify({
          bookingId: input.bookingId,
          paymentId,
          totalPrice: input.totalPrice,
          paymentTimestamp,
        }),
      }],
    }));

    logger.info('Payment processed successfully', { bookingId: input.bookingId, paymentId });

    return { ...input, paymentId, paymentTimestamp };
  } catch (err) {
    logger.error('Payment processing failed', { error: err });
    metrics.addMetric('PaymentFailures', MetricUnit.Count, 1);
    throw err;
  } finally {
    subsegment?.close();
    metrics.publishStoredMetrics();
  }
};
