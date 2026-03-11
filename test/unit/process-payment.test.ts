import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const ebMock = mockClient(EventBridgeClient);

process.env.FLIGHTS_TABLE = 'test-flights';
process.env.BOOKINGS_TABLE = 'test-bookings';
process.env.EVENT_BUS_NAME = 'test-bus';
process.env.POWERTOOLS_DEV = 'true';

import { handler } from '../../src/functions/booking-workflow/process-payment';

const baseInput = {
  bookingId: 'bk-123',
  userId: 'user-abc',
  flightId: 'FL-001',
  seats: 2,
  paymentToken: 'tok_valid',
  totalPrice: 200,
  reservationTimestamp: '2024-01-01T00:00:00.000Z',
};

beforeEach(() => {
  ebMock.reset();
  delete process.env.FORCE_PAYMENT_FAILURE;
});

describe('process-payment', () => {
  it('processes valid payment successfully', async () => {
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    const result = await handler(baseInput);

    expect(result.paymentId).toMatch(/^pay_/);
    expect(result.paymentTimestamp).toBeDefined();
    expect(ebMock).toHaveReceivedCommandWith(PutEventsCommand, {
      Entries: expect.arrayContaining([
        expect.objectContaining({ DetailType: 'PaymentProcessed' }),
      ]),
    });
  });

  it('fails when FORCE_PAYMENT_FAILURE is set', async () => {
    process.env.FORCE_PAYMENT_FAILURE = 'true';

    await expect(handler(baseInput)).rejects.toThrow('Payment forced to fail for testing');
  });

  it('fails for explicitly failing tokens', async () => {
    const failInput = { ...baseInput, paymentToken: 'tok_fail' };
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await expect(handler(failInput)).rejects.toThrow('Payment declined');
  });

  it('fails for tokens starting with fail_', async () => {
    const failInput = { ...baseInput, paymentToken: 'fail_card_expired' };
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await expect(handler(failInput)).rejects.toThrow('Payment declined');
  });
});
