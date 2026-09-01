# AWS Architecture

High-level view of the resources provisioned by the Pulumi stack in `infra/` (see `infra/index.ts` and `infra/lib/*`). Supporting resources are omitted below for readability, including: IAM roles/policies and Lambda invoke permissions (one role per Lambda — note that `dataApiPolicyStatements` grants the same Data API actions, including transactions/batch writes, to every DB-backed route even though only `ingest` uses transactions), `ManagedLoginBranding`, the API Gateway `Deployment`/`Stage`, the RDS `SubnetGroup`, and the SQS queue policy/S3 bucket notification/Lambda event source mapping (shown only as the edges they wire up).

```mermaid
graph TB
  subgraph Auth["Cognito Auth (cognito.ts)"]
    UserPool["Cognito User Pool<br/>draupnir-users"]
    GoogleIdP["Google Identity Provider"]
    UserPoolClient["User Pool Client<br/>draupnir-app"]
    Domain["User Pool Domain<br/>Managed Login"]
    PreSignUpFn["λ pre-sign-up-trigger"]

    UserPool --> GoogleIdP
    UserPool --> UserPoolClient
    UserPool --> Domain
    UserPool -. invokes .-> PreSignUpFn
  end

  subgraph API["API Gateway (ingestionApi.ts)"]
    RestApi["REST API<br/>draupnir-ingestion (stage = stack)"]
    Authorizer["Cognito Authorizer"]
    WhoamiFn["λ whoami<br/>GET /whoami"]
    AccountsFn["λ accounts<br/>POST /accounts"]
    UploadFn["λ presigned-upload<br/>POST /uploads"]

    RestApi --> Authorizer
    RestApi --> WhoamiFn
    RestApi --> AccountsFn
    RestApi --> UploadFn
  end
  Authorizer -. validates JWT against .-> UserPool

  subgraph Ingestion["Ingestion Pipeline (ingestionPipeline.ts)"]
    UploadsBucket[("S3: uploads")]
    Queue["SQS: ingestion"]
    DLQ["SQS: ingestion-dlq"]
    IngestFn["λ ingest"]

    UploadsBucket -- "s3:ObjectCreated" --> Queue
    Queue -- "event source mapping" --> IngestFn
    Queue -. "maxReceiveCount 5" .-> DLQ
  end

  subgraph Data["Aurora (aurora.ts) — private VPC, no NAT/IGW"]
    VPC["VPC 10.0.0.0/16"]
    SubnetA["Subnet AZ-a"]
    SubnetB["Subnet AZ-b"]
    SG["Security Group<br/>(no ingress rules)"]
    Cluster["Aurora PostgreSQL 17.7<br/>Serverless v2, 0-1 ACU<br/>RDS Data API enabled"]
    Instance["DB Instance<br/>db.serverless"]
    Secret[("Secrets Manager<br/>master user password")]

    VPC --> SubnetA & SubnetB & SG
    SubnetA & SubnetB -- "DB subnet group" --> Cluster
    SG -- "vpcSecurityGroupIds" --> Cluster
    Cluster --> Instance
    Cluster -. "manageMasterUserPassword" .-> Secret
  end

  UploadFn -. "presigns a PutObject URL for" .-> UploadsBucket
  UploadFn -- "RDS Data API" --> Cluster
  AccountsFn -- "RDS Data API" --> Cluster
  IngestFn -- "s3:GetObject" --> UploadsBucket
  IngestFn -- "RDS Data API" --> Cluster
```

## Notes

- **No direct network path to Aurora.** Every DB-backed Lambda talks to the cluster exclusively through the RDS Data API's HTTPS endpoint (ADR-0003) — the security group has no ingress rules, and the VPC has no NAT/internet gateway.
- **Aurora scales to zero** (`minCapacity: 0`, `secondsUntilAutoPause: 300`) — near-zero idle cost, at the price of a resume delay (seconds to ~1 minute) on the first request after idle. DB-backed API routes are given a 29s timeout (API Gateway's ceiling without a quota increase) to absorb this.
- **`whoami`** is the one API route that doesn't touch Aurora or S3 — no DB/bucket environment variables, no extra IAM policy statements beyond basic Lambda execution.
- Deletion protection + a final snapshot are enabled on the Aurora cluster since it holds live account/transaction data.

See the ADRs in `docs/adr/` for the reasoning behind these choices, and `infra/lib/*.ts` for the resource definitions.
