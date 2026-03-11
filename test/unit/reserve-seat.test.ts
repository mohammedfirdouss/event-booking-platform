import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

// Set env vars before importing handler
process.env.FLIGHTS_TABLE = 'test-flights';
process.env.BOOKINGS_TABLE = 'test-bookings';
process.env.LOYALTY_TABLE = 'test-loyalty';
process.env.EVENT_BUS_NAME = 'test-bus';
process.env.POWERTOOLS_DEV = 'true';

import { handler } from '../../src/functions/booking-workflow/reserve-seat';

const baseInput = {
  bookingId: 'bk-123',
  userId: 'user-abc',
  flightId: 'FL-001',
  seats: 2,
  paymentToken: 'tok_test',
};

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
});

describe('reserve-seat', () => {
  it('successfully reserves seats when availability is sufficient', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { flightId: 'FL-001', availableSeats: 5, price: 100 },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    const result = await handler(baseInput);

    expect(result.bookingId).toBe('bk-123');
    expect(result.reservationTimestamp).toBeDefined();
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      ExpressionAttributeValues: { ':seats': 2 },
    });
    expect(ebMock).toHaveReceivedCommandWith(PutEventsCommand, {
      Entries: expect.arrayContaining([
        expect.objectContaining({ DetailType: 'SeatReserved' }),
      ]),
    });
  });

  it('throws when flight is not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await expect(handler(baseInput)).rejects.toThrow('FL-001 not found');
  });

  it('throws when insufficient seats', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { flightId: 'FL-001', availableSeats: 1, price: 100 },
    });
    // UpdateCommand will throw ConditionalCheckFailedException
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(err);

    await expect(handler(baseInput)).rejects.toThrow();
  });
});
