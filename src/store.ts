import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Vault, SafeError, digest, canonical, opaque } from "./security.js";
export interface Account {
  id: string;
  owner_id: string;
  alias: string;
  display_name: string;
  buffer_account_id: string;
  verified_email: string;
  status: "enabled" | "disabled";
  credential_version: number;
  credential_ciphertext: string;
}
export interface Identity {
  id: string;
  email: string;
  name: string;
  organizations: Array<{ id: string; name: string }>;
  channels: Array<{ id: string; organizationId: string; name: string }>;
}
export const publicAccount = (a: Account) => ({
  id: a.id,
  alias: a.alias,
  display_name: a.display_name,
  buffer_account_id: a.buffer_account_id,
  verified_email: a.verified_email,
  status: a.status,
});
export class Store {
  constructor(
    readonly db: Pool,
    readonly vault: Vault,
  ) {}
  async owner(subject: string) {
    const r = await this.db.query(
      "INSERT INTO owners(id,identity_subject) VALUES($1,$2) ON CONFLICT(identity_subject) DO UPDATE SET identity_subject=EXCLUDED.identity_subject RETURNING id",
      [randomUUID(), subject],
    );
    return r.rows[0].id as string;
  }
  async list(owner: string) {
    return (
      await this.db.query<Account>(
        "SELECT * FROM buffer_accounts WHERE owner_id=$1 ORDER BY created_at,id",
        [owner],
      )
    ).rows;
  }
  async account(owner: string, id: string, enabled = true) {
    const a = (
      await this.db.query<Account>(
        "SELECT * FROM buffer_accounts WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!a || (enabled && a.status !== "enabled"))
      throw new SafeError("ACCOUNT_UNAVAILABLE", 404);
    return a;
  }
  key(a: Account) {
    return this.vault.open<{ kind: "api_key"; value: string }>(
      a.credential_ciphertext,
      `credential:${a.owner_id}:${a.id}`,
    ).value;
  }
  async save(
    owner: string,
    alias: string,
    key: string,
    identity: Identity,
    replace?: string,
  ) {
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(alias))
      throw new SafeError("INVALID_ALIAS");
    const existing = (
      await this.db.query<Account>(
        "SELECT * FROM buffer_accounts WHERE owner_id=$1 AND buffer_account_id=$2",
        [owner, identity.id],
      )
    ).rows[0];
    if (existing && replace !== existing.id)
      throw new SafeError("DUPLICATE_IDENTITY_REPLACE_" + existing.id, 409);
    const id = replace || randomUUID();
    if (
      replace &&
      (await this.account(owner, replace, false)).buffer_account_id !==
        identity.id
    )
      throw new SafeError("ROTATION_IDENTITY_MISMATCH", 409);
    const ciphertext = this.vault.seal(
      { kind: "api_key", value: key },
      `credential:${owner}:${id}`,
    );
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      if (replace)
        await c.query(
          "UPDATE buffer_accounts SET alias=$3,display_name=$4,verified_email=$5,credential_ciphertext=$6,credential_version=credential_version+1,encryption_key_version=$7,last_verified_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2",
          [
            owner,
            id,
            alias,
            identity.name,
            identity.email,
            ciphertext,
            this.vault.active,
          ],
        );
      else
        await c.query(
          "INSERT INTO buffer_accounts(id,owner_id,alias,display_name,buffer_account_id,verified_email,status,credential_ciphertext,encryption_key_version) VALUES($1,$2,$3,$4,$5,$6,'enabled',$7,$8)",
          [
            id,
            owner,
            alias,
            identity.name,
            identity.id,
            identity.email,
            ciphertext,
            this.vault.active,
          ],
        );
      await c.query(
        "DELETE FROM account_inventory WHERE owner_id=$1 AND account_id=$2",
        [owner, id],
      );
      for (const ch of identity.channels)
        await c.query(
          "INSERT INTO account_inventory(owner_id,account_id,organization_id,channel_id,display_metadata) VALUES($1,$2,$3,$4,$5)",
          [
            owner,
            id,
            ch.organizationId,
            ch.id,
            JSON.stringify({ name: ch.name }),
          ],
        );
      await c.query("COMMIT");
      return id;
    } catch (e) {
      await c.query("ROLLBACK");
      if ((e as any).code === "23505")
        throw new SafeError("DUPLICATE_ALIAS_OR_IDENTITY", 409);
      throw e;
    } finally {
      c.release();
    }
  }
  async change(owner: string, id: string, action: string, value?: string) {
    await this.account(owner, id, false);
    if (action === "remove") {
      await this.db.query(
        "DELETE FROM web_sessions WHERE owner_id=$1 AND kind='onboarding'",
        [owner],
      );
      await this.db.query(
        "DELETE FROM buffer_accounts WHERE owner_id=$1 AND id=$2",
        [owner, id],
      );
    } else if (action === "rename") {
      if (!value || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(value))
        throw new SafeError("INVALID_ALIAS");
      await this.db.query(
        "UPDATE buffer_accounts SET alias=$3,updated_at=now() WHERE owner_id=$1 AND id=$2",
        [owner, id, value],
      );
    } else if (["enable", "disable"].includes(action))
      await this.db.query(
        "UPDATE buffer_accounts SET status=$3,credential_version=credential_version+1,updated_at=now() WHERE owner_id=$1 AND id=$2",
        [owner, id, action === "enable" ? "enabled" : "disabled"],
      );
    else throw new SafeError("INVALID_ACTION");
  }
  async audit(
    owner: string,
    account: string | null,
    tool: string,
    request: string,
    outcome: string,
  ) {
    await this.db.query(
      "INSERT INTO audit_events(owner_id,account_id,tool_name,request_id,outcome) VALUES($1,$2,$3,$4,$5)",
      [owner, account, tool, request, outcome],
    );
  }
  async session(
    kind: string,
    payload: unknown,
    owner: string | null = null,
    seconds = 600,
  ) {
    const id = opaque();
    const hash = digest(id);
    await this.db.query(
      "INSERT INTO web_sessions(id_hash,kind,owner_id,ciphertext,expires_at) VALUES($1,$2,$3,$4,$5)",
      [
        hash,
        kind,
        owner,
        this.vault.seal(payload, `session:${hash}`),
        new Date(Date.now() + seconds * 1000),
      ],
    );
    return id;
  }
  async getSession<T>(
    id: string,
    kind: string,
    consume = false,
  ): Promise<{ owner: string; data: T } | undefined> {
    const hash = digest(id);
    const q = consume
      ? "DELETE FROM web_sessions WHERE id_hash=$1 AND kind=$2 AND expires_at>now() RETURNING *"
      : "SELECT * FROM web_sessions WHERE id_hash=$1 AND kind=$2 AND expires_at>now()";
    const r = (await this.db.query(q, [hash, kind])).rows[0];
    return r
      ? {
          owner: r.owner_id,
          data: this.vault.open<T>(r.ciphertext, `session:${hash}`),
        }
      : undefined;
  }
  async dropSession(id: string) {
    await this.db.query("DELETE FROM web_sessions WHERE id_hash=$1", [
      digest(id),
    ]);
  }
  async beginWrite(
    owner: string,
    account: string,
    operation: string,
    tool: string,
    args: unknown,
  ) {
    const hash = digest(canonical(args));
    const r = await this.db.query(
      "INSERT INTO write_operations(owner_id,account_id,operation_id,tool_name,arguments_hash,status) VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT DO NOTHING RETURNING operation_id",
      [owner, account, operation, tool, hash],
    );
    if (r.rowCount) return { fresh: true as const };
    const old = (
      await this.db.query(
        "SELECT * FROM write_operations WHERE owner_id=$1 AND operation_id=$2",
        [owner, operation],
      )
    ).rows[0];
    if (
      old.account_id !== account ||
      old.tool_name !== tool ||
      old.arguments_hash !== hash
    )
      throw new SafeError("OPERATION_ID_CONFLICT", 409);
    if (old.status === "completed")
      return {
        fresh: false as const,
        result: this.vault.open<any>(
          old.result_ciphertext,
          `operation:${owner}:${operation}`,
        ),
      };
    if (
      old.status === "pending" &&
      Date.now() - new Date(old.updated_at).getTime() > 120000
    ) {
      await this.unknownWrite(owner, operation);
      old.status = "unknown";
    }
    return {
      fresh: false as const,
      result: {
        status: old.status,
        operation_id: operation,
        message:
          "Outcome unresolved; never automatically resend. Inspect Buffer before deciding on a new operation.",
      },
    };
  }
  async finishWrite(owner: string, operation: string, result: unknown) {
    await this.db.query(
      "UPDATE write_operations SET status='completed',result_ciphertext=$3,updated_at=now() WHERE owner_id=$1 AND operation_id=$2",
      [
        owner,
        operation,
        this.vault.seal(result, `operation:${owner}:${operation}`),
      ],
    );
  }
  async unknownWrite(owner: string, operation: string) {
    await this.db.query(
      "UPDATE write_operations SET status='unknown',updated_at=now() WHERE owner_id=$1 AND operation_id=$2",
      [owner, operation],
    );
  }
}
