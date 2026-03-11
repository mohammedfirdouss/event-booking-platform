import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import * as path from 'path';
import { PoweredLambda } from '../constructs/powered-lambda';
import { DataStack } from './data-stack';
import { AuthStack } from './auth-stack';
import { BookingStack } from './booking-stack';
import { EventsStack } from './events-stack';

export interface ApiStackProps extends cdk.StackProps {
  envName: string;
  dataStack: DataStack;
  authStack: AuthStack;
  bookingStack: BookingStack;
  eventsStack: EventsStack;
}

export class ApiStack extends cdk.Stack {
  public readonly api: appsync.GraphqlApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { envName, dataStack, authStack, bookingStack, eventsStack } = props;

    // ── AppSync API ───────────────────────────────────────────────────────
    this.api = new appsync.GraphqlApi(this, 'Api', {
      name: `airline-booking-api-${envName}`,
      schema: appsync.SchemaFile.fromAsset(
        path.join(__dirname, '../../graphql/schema.graphql')
      ),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool: authStack.userPool },
        },
        additionalAuthorizationModes: [
          { authorizationType: appsync.AuthorizationType.IAM },
        ],
      },
      xrayEnabled: true,
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.ERROR,
        excludeVerboseContent: false,
      },
    });

    const commonEnv = {
      FLIGHTS_TABLE: dataStack.flightsTable.tableName,
      BOOKINGS_TABLE: dataStack.bookingsTable.tableName,
      LOYALTY_TABLE: dataStack.loyaltyTable.tableName,
      STATE_MACHINE_ARN: bookingStack.stateMachine.stateMachineArn,
      EVENT_BUS_NAME: eventsStack.eventBus.eventBusName,
    };

    // ── Resolver Lambdas ──────────────────────────────────────────────────
    const searchFlightsFn = new PoweredLambda(this, 'SearchFlights', {
      functionPath: 'resolvers/search-flights.ts',
      serviceName: 'search-flights',
      environment: commonEnv,
    });

    const getBookingFn = new PoweredLambda(this, 'GetBooking', {
      functionPath: 'resolvers/get-booking.ts',
      serviceName: 'get-booking',
      environment: commonEnv,
    });

    const createBookingFn = new PoweredLambda(this, 'CreateBooking', {
      functionPath: 'resolvers/create-booking.ts',
      serviceName: 'create-booking',
      environment: commonEnv,
    });

    const loyaltyBalanceFn = new PoweredLambda(this, 'LoyaltyBalance', {
      functionPath: 'resolvers/loyalty-balance.ts',
      serviceName: 'loyalty-balance',
      environment: commonEnv,
    });

    // ── Event handler Lambdas ─────────────────────────────────────────────
    const awardLoyaltyFn = new PoweredLambda(this, 'AwardLoyalty', {
      functionPath: 'event-handlers/award-loyalty.ts',
      serviceName: 'award-loyalty',
      environment: {
        LOYALTY_TABLE: dataStack.loyaltyTable.tableName,
        EVENT_BUS_NAME: eventsStack.eventBus.eventBusName,
      },
    });

    const bookingStatusPubFn = new PoweredLambda(this, 'BookingStatusPub', {
      functionPath: 'event-handlers/booking-status-pub.ts',
      serviceName: 'booking-status-pub',
      environment: {
        APPSYNC_ENDPOINT: this.api.graphqlUrl,
        AWS_APPSYNC_REGION: this.region,
      },
    });

    // ── Grant permissions ─────────────────────────────────────────────────
    dataStack.flightsTable.grantReadData(searchFlightsFn);
    dataStack.bookingsTable.grantReadData(getBookingFn);
    dataStack.bookingsTable.grantReadWriteData(createBookingFn);
    dataStack.loyaltyTable.grantReadData(loyaltyBalanceFn);
    dataStack.loyaltyTable.grantReadWriteData(awardLoyaltyFn);
    bookingStack.stateMachine.grantStartExecution(createBookingFn);
    eventsStack.eventBus.grantPutEventsTo(createBookingFn);

    // AppSync IAM permission for booking-status-pub
    this.api.grantMutation(bookingStatusPubFn, 'updateBookingStatus');

    // ── AppSync Data Sources ──────────────────────────────────────────────
    const searchFlightsDS = this.api.addLambdaDataSource('SearchFlightsDS', searchFlightsFn);
    const getBookingDS = this.api.addLambdaDataSource('GetBookingDS', getBookingFn);
    const createBookingDS = this.api.addLambdaDataSource('CreateBookingDS', createBookingFn);
    const loyaltyDS = this.api.addLambdaDataSource('LoyaltyDS', loyaltyBalanceFn);

    // ── Resolvers ─────────────────────────────────────────────────────────
    searchFlightsDS.createResolver('SearchFlightsResolver', {
      typeName: 'Query',
      fieldName: 'searchFlights',
    });

    getBookingDS.createResolver('GetBookingResolver', {
      typeName: 'Query',
      fieldName: 'getBooking',
    });

    getBookingDS.createResolver('GetUserBookingsResolver', {
      typeName: 'Query',
      fieldName: 'getUserBookings',
    });

    loyaltyDS.createResolver('LoyaltyBalanceResolver', {
      typeName: 'Query',
      fieldName: 'getLoyaltyBalance',
    });

    createBookingDS.createResolver('CreateBookingResolver', {
      typeName: 'Mutation',
      fieldName: 'createBooking',
    });

    createBookingDS.createResolver('CancelBookingResolver', {
      typeName: 'Mutation',
      fieldName: 'cancelBooking',
    });

    // updateBookingStatus is triggered by booking-status-pub Lambda via IAM
    const statusPubDS = this.api.addLambdaDataSource('StatusPubDS', bookingStatusPubFn);
    statusPubDS.createResolver('UpdateBookingStatusResolver', {
      typeName: 'Mutation',
      fieldName: 'updateBookingStatus',
    });

    // ── EventBridge rules for event handlers ─────────────────────────────
    new events.Rule(this, 'LoyaltyRule', {
      eventBus: eventsStack.eventBus,
      ruleName: `airline-loyalty-rule-${envName}`,
      description: 'Routes BookingConfirmed events to award-loyalty Lambda',
      eventPattern: {
        source: ['booking.workflow'],
        detailType: ['BookingConfirmed'],
      },
      targets: [new targets.LambdaFunction(awardLoyaltyFn)],
    });

    new events.Rule(this, 'SubscriptionRule', {
      eventBus: eventsStack.eventBus,
      ruleName: `airline-subscription-rule-${envName}`,
      description: 'Routes all booking events to booking-status-pub Lambda',
      eventPattern: {
        source: ['booking.workflow'],
      },
      targets: [new targets.LambdaFunction(bookingStatusPubFn)],
    });

    new cdk.CfnOutput(this, 'GraphqlUrl', { value: this.api.graphqlUrl });
    new cdk.CfnOutput(this, 'ApiId', { value: this.api.apiId });
  }
}
