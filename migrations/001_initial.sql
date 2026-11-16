CREATE TABLE IF NOT EXISTS owners (
 id uuid PRIMARY KEY, identity_subject text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS buffer_accounts (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id), alias text NOT NULL,
 display_name text NOT NULL, buffer_account_id text NOT NULL, verified_email text NOT NULL,
 status text NOT NULL CHECK(status IN ('enabled','disabled')),
 credential_ciphertext text NOT NULL, credential_kind text NOT NULL DEFAULT 'api_key',
 credential_version integer NOT NULL DEFAULT 1, encryption_key_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), last_verified_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,alias), UNIQUE(owner_id,buffer_account_id), UNIQUE(owner_id,id)
);
CREATE TABLE IF NOT EXISTS account_inventory (
 owner_id uuid NOT NULL, account_id uuid NOT NULL, organization_id text NOT NULL, channel_id text NOT NULL,
 display_metadata jsonb NOT NULL, verified_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,account_id,organization_id,channel_id),
 FOREIGN KEY(owner_id,account_id) REFERENCES buffer_accounts(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS audit_events (
 id bigserial PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id), account_id uuid,
 tool_name text NOT NULL, request_id uuid NOT NULL, outcome text NOT NULL,
 timestamp timestamptz NOT NULL DEFAULT now(), sanitized_metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS write_operations (
 owner_id uuid NOT NULL REFERENCES owners(id), account_id uuid NOT NULL, operation_id uuid NOT NULL,
 tool_name text NOT NULL, arguments_hash text NOT NULL, status text NOT NULL CHECK(status IN ('pending','completed','unknown')),
 result_ciphertext text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,operation_id)
);
CREATE TABLE IF NOT EXISTS web_sessions (
 id_hash text PRIMARY KEY, kind text NOT NULL, owner_id uuid REFERENCES owners(id), ciphertext text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS web_sessions_expiry ON web_sessions(expires_at);
CREATE INDEX IF NOT EXISTS audit_owner_time ON audit_events(owner_id,timestamp);
