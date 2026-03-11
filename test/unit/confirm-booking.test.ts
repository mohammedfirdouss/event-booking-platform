import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

process.env.BOOKINGS_TABLE = 'test-bookings';
process.env.EVENT_BUS_NAME = 'test-bus';
process.env.POWERTOOLS_DEV = 'true';

import { handler } from '../../src/functions/booking-workflow/confirm-booking';

const baseInput = {
  bookingId: 'bk-123',
  userId: 'user-abc',
  flightId: 'FL-001',
  seats: 2,
  paymentToken: 'tok_valid',
  totalPrice: 200,
  reservationTimestamp: '2024-01-01T00:00:00.000Z',
  paymentId: 'pay_abc123',
  paymentTimestamp: '2024-01-01T00:00:01.000Z',
};

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
});

describe('confirm-booking', () => {
  it('confirms a pending booking', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    const result = await handler(baseInput);

    expect(result.confirmedAt).toBeDefined();
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      ExpressionAttributeValues: expect.objectContaining({
        ':status': 'CONFIRMED',
        ':price': 200,
      }),
    });
    expect(ebMock).toHaveReceivedCommandWith(PutEventsCommand, {
      Entries: expect.arrayContaining([
        expect.objectContaining({ DetailType: 'BookingConfirmed' }),
      ]),
    });
  });

  it('rethrows DynamoDB errors', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('ConditionalCheckFailedException'));

    await expect(handler(baseInput)).rejects.toThrow('ConditionalCheckFailedException');
  });
});
