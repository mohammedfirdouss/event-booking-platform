import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface PoweredLambdaProps extends Omit<NodejsFunctionProps, 'runtime' | 'tracing'> {
  /** Path relative to src/functions/ */
  functionPath: string;
  serviceName?: string;
  logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  environment?: Record<string, string>;
}

/**
 * L3 construct: NodejsFunction with AWS Lambda Powertools configured,
 * X-Ray active tracing, and standardised bundling settings.
 */
export class PoweredLambda extends NodejsFunction {
  constructor(scope: Construct, id: string, props: PoweredLambdaProps) {
    const { functionPath, serviceName, logLevel = 'INFO', environment = {}, ...rest } = props;

    super(scope, id, {
      runtime: lambda.Runtime.NODEJS_22_X,
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      entry: path.join(__dirname, '../../src/functions', functionPath),
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
        externalModules: [
          '@aws-sdk/*',
        ],
      },
      environment: {
        POWERTOOLS_SERVICE_NAME: serviceName ?? id,
        LOG_LEVEL: logLevel,
        POWERTOOLS_TRACER_CAPTURE_RESPONSE: 'true',
        POWERTOOLS_TRACER_CAPTURE_ERROR: 'true',
        POWERTOOLS_METRICS_NAMESPACE: 'AirlineBooking',
        NODE_OPTIONS: '--enable-source-maps',
        ...environment,
      },
      ...rest,
    });
  }
}
