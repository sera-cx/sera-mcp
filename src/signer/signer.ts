import { Wallet, TypedDataDomain, TypedDataField } from "ethers";
import type { SeraIntent } from "../sera/types.js";

export type SignerMode = "local" | "external" | "readonly";

export interface SignedIntent {
  intent: SeraIntent;
  signature: string;
  taker: string;
}

export interface Signer {
  mode: SignerMode;
  /** Address that will be the `taker` on Intents. May be undefined in external mode. */
  address(): Promise<string | undefined>;
  /** Sign an Intent. Throws if mode !== "local". */
  signIntent(intent: SeraIntent, domain: TypedDataDomain): Promise<SignedIntent>;
}

const INTENT_TYPES: Record<string, TypedDataField[]> = {
  Intent: [
    { name: "taker", type: "address" },
    { name: "inputToken", type: "address" },
    { name: "outputToken", type: "address" },
    { name: "maxInputAmount", type: "uint256" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "initialDepositAmount", type: "uint256" },
    { name: "uuid", type: "uint256" },
    { name: "deadline", type: "uint48" },
  ],
};

/**
 * A 32-byte hex private key, with or without the 0x prefix.
 * Surrounding whitespace is tolerated and stripped by the caller — secret files
 * and `docker secret` mounts routinely carry a trailing newline.
 */
const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

class LocalSigner implements Signer {
  readonly mode: SignerMode = "local";
  private wallet: Wallet;
  constructor(privateKey: string) {
    // Validate the SHAPE ourselves before handing the value to ethers.
    //
    // ethers only redacts the key when it parses as 32 bytes of hex. For any
    // other input `getBytes` throws "invalid BytesLike value (... value="<the
    // raw key>" ...)", and that message travels in err.stack up to the fatal
    // handler in src/index.ts, which JSON-logs it to stderr. A key with a
    // trailing newline — the normal result of reading a secret file — would
    // therefore be printed in full to the container log.
    //
    // Never interpolate the key (or any slice of it) into what we throw.
    const trimmed = privateKey.trim();
    if (!PRIVATE_KEY_RE.test(trimmed)) {
      throw new Error(
        "SIGNER_PRIVATE_KEY is not a valid private key: expected 32 bytes of hex " +
          `(64 hex chars, optional 0x prefix), got ${trimmed.length} characters. ` +
          "Value withheld from this message and from logs.",
      );
    }
    try {
      this.wallet = new Wallet(trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`);
    } catch {
      // Shape was right but ethers still rejected it (e.g. key out of the
      // secp256k1 range). Swallow the original error — it embeds the key.
      throw new Error(
        "SIGNER_PRIVATE_KEY is well-formed hex but was rejected as a secp256k1 key. " +
          "Value withheld from this message and from logs.",
      );
    }
  }
  async address() {
    return this.wallet.address;
  }
  async signIntent(intent: SeraIntent, domain: TypedDataDomain): Promise<SignedIntent> {
    // ethers v6 signs typed data with `signTypedData`.
    const signature = await this.wallet.signTypedData(domain, INTENT_TYPES, intent as any);
    return { intent, signature, taker: this.wallet.address };
  }
}

class ExternalSigner implements Signer {
  readonly mode: SignerMode = "external";
  async address() {
    return undefined;
  }
  async signIntent(): Promise<SignedIntent> {
    throw new Error(
      "Signer is in 'external' mode. Use sera.prepare_swap to obtain route_params + EIP-712 domain, " +
        "sign them in your wallet, and submit via sera.execute_swap.",
    );
  }
}

class ReadonlySigner implements Signer {
  readonly mode: SignerMode = "readonly";
  async address() {
    return undefined;
  }
  async signIntent(): Promise<SignedIntent> {
    throw new Error("Signer is in 'readonly' mode. Execution tools are disabled.");
  }
}

export function createSigner(mode: SignerMode, privateKey?: string): Signer {
  switch (mode) {
    case "local":
      if (!privateKey) throw new Error("SIGNER_PRIVATE_KEY required when SERA_SIGNER_MODE=local");
      return new LocalSigner(privateKey);
    case "external":
      return new ExternalSigner();
    case "readonly":
      return new ReadonlySigner();
  }
}

export { INTENT_TYPES };
