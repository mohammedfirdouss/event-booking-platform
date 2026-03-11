import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddbMock = mockClient(DynamoDBDocumentClient);

process.env.LOYALTY_TABLE = 'test-loyalty';
process.env.EVENT_BUS_NAME = 'test-bus';
process.env.POWERTOOLS_DEV = 'true';

import { handler } from '../../src/functions/event-handlers/award-loyalty';
import type { EventBridgeEvent } from 'aws-lambda';

interface BookingConfirmedDetail {
  bookingId: string;
  userId: string;
  flightId: string;
  seats: number;
  totalPrice: number;
  confirmedAt: string;
}

function makeEvent(detail: BookingConfirmedDetail): EventBridgeEvent<'BookingConfirmed', BookingConfirmedDetail> {
  return {
    version: '0',
    id: 'evt-1',
    source: 'booking.workflow',
    account: '123456789',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    'detail-type': 'BookingConfirmed',
    detail,
  };
}

beforeEach(() => {
  ddbMock.reset();
});

describe('award-loyalty', () => {
  it('awards 1 point per dollar of total price', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeEvent({
      bookingId: 'bk-1',
      userId: 'usr-1',
      totalPrice: 350,
      flightId: 'FL-001',
      seats: 2,
      confirmedAt: '2024-01-01T00:00:00Z',
    }));

    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      Key: { userId: 'usr-1' },
      ExpressionAttributeValues: { ':points': 350 },
    });
  });

  it('awards 0 points for zero-price bookings', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeEvent({
      bookingId: 'bk-2',
      userId: 'usr-2',
      totalPrice: 0,
      flightId: 'FL-001',
      seats: 1,
      confirmedAt: '2024-01-01T00:00:00Z',
    }));

    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      ExpressionAttributeValues: { ':points': 0 },
    });
  });

  it('floors fractional points', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeEvent({
      bookingId: 'bk-3',
      userId: 'usr-3',
      totalPrice: 99.99,
      flightId: 'FL-001',
      seats: 1,
      confirmedAt: '2024-01-01T00:00:00Z',
    }));

    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      ExpressionAttributeValues: { ':points': 99 },
    });
  });
});
