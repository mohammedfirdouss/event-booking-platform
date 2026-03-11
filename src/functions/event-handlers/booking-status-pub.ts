import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import type { EventBridgeEvent } from 'aws-lambda';

const logger = new Logger({ serviceName: 'booking-status-pub' });
const tracer = new Tracer({ serviceName: 'booking-status-pub' });

// Map EventBridge detail-types to AppSync BookingStatus enum values
const STATUS_MAP: Record<string, string> = {
  BookingConfirmed: 'CONFIRMED',
  BookingCancelled: 'CANCELLED',
  BookingFailed: 'FAILED',
  SeatReserved: 'PENDING',
  PaymentProcessed: 'PENDING',
};

interface BookingEventDetail {
  bookingId: string;
  [key: string]: unknown;
}

async function callAppSync(endpoint: string, region: string, mutation: string): Promise<void> {
  const url = new URL(endpoint);

  const signer = new SignatureV4({
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    },
    region,
    service: 'appsync',
    sha256: Sha256,
  });

  const requestBody = JSON.stringify({ query: mutation });

  const request = {
    method: 'POST',
    hostname: url.hostname,
    path: url.pathname,
    protocol: url.protocol,
    headers: {
      'Content-Type': 'application/json',
      host: url.hostname,
    },
    body: requestBody,
  };

  const signed = await signer.sign(request);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body: requestBody,
  });

  if (!response.ok) {
    throw new Error(`AppSync call failed: ${response.status} ${await response.text()}`);
  }
}

export const handler = async (
  event: EventBridgeEvent<string, BookingEventDetail>
): Promise<void> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('bookingStatusPub');

  try {
    const { bookingId } = event.detail;
    const status = STATUS_MAP[event['detail-type']];

    if (!status || !bookingId) {
      logger.debug('Skipping event — no status mapping or bookingId', {
        detailType: event['detail-type'],
      });
      return;
    }

    logger.info('Publishing booking status update', { bookingId, status });

    const endpoint = process.env.APPSYNC_ENDPOINT!;
    const region = process.env.AWS_APPSYNC_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

    const mutation = `
      mutation UpdateBookingStatus {
        updateBookingStatus(bookingId: "${bookingId}", status: ${status}) {
          bookingId
          status
        }
      }
    `;

    await callAppSync(endpoint, region, mutation);
    logger.info('Status update published', { bookingId, status });
  } catch (err) {
    logger.error('Error publishing status update', { error: err });
    throw err;
  } finally {
    subsegment?.close();
  }
};
