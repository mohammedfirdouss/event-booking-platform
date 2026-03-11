import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface DataStackProps extends cdk.StackProps {
  envName: string;
}

export class DataStack extends cdk.Stack {
  public readonly flightsTable: dynamodb.Table;
  public readonly bookingsTable: dynamodb.Table;
  public readonly loyaltyTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { envName } = props;

    this.flightsTable = new dynamodb.Table(this, 'FlightsTable', {
      tableName: `airline-flights-${envName}`,
      partitionKey: { name: 'flightId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: envName === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    this.flightsTable.addGlobalSecondaryIndex({
      indexName: 'departureDate-origin-index',
      partitionKey: { name: 'departureDate', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'origin', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.bookingsTable = new dynamodb.Table(this, 'BookingsTable', {
      tableName: `airline-bookings-${envName}`,
      partitionKey: { name: 'bookingId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: envName === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    this.bookingsTable.addGlobalSecondaryIndex({
      indexName: 'userId-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.loyaltyTable = new dynamodb.Table(this, 'LoyaltyTable', {
      tableName: `airline-loyalty-${envName}`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: envName === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'FlightsTableName', { value: this.flightsTable.tableName });
    new cdk.CfnOutput(this, 'BookingsTableName', { value: this.bookingsTable.tableName });
    new cdk.CfnOutput(this, 'LoyaltyTableName', { value: this.loyaltyTable.tableName });
  }
}
