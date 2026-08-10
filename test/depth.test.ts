import { describe, it, expect } from "vitest";
import { inferBook } from "../src/tools/depth.js";
import { fromRawAmount, toRawAmount } from "../src/sera/tokens.js";
import type { AppContext } from "../src/config.js";
import type { SwapQuoteRequest } from "../src/sera/types.js";

const BASE = "0x" + "1".repeat(40);
const QUOTE = "0x" + "2".repeat(40);

function makeCtx(): AppContext {
  return {
    sera: {
      getTokens: async () => ({
        tokens: [
          { symbol: "BASE", address: BASE, decimals: 6, fiat_currency: "USD" },
          { symbol: "QUOTE", address: QUOTE, decimals: 6, fiat_currency: "SGD" },
        ],
      }),
      getSystemTime: async () => ({ timestamp: 1_000 }),
      postSwapQuote: async (req: SwapQuoteRequest) => {
        const size = Number(fromRawAmount(req.from_amount, 6));
        let output: number;

        if (req.from_token === BASE && req.to_token === QUOTE) {
          output = size === 100 ? 100 : 1_100;
        } else if (req.from_token === QUOTE && req.to_token === BASE) {
          output = size === 100 ? 80 : 833.333333;
        } else {
          throw new Error("unexpected pair");
        }

        return {
          uuid: String(size),
          route_params: {
            taker: req.owner_address,
            inputToken: req.from_token,
            outputToken: req.to_token,
            maxInputAmount: req.from_amount,
            minOutputAmount: toRawAmount(output, 6),
            recipient: req.recipient,
            initialDepositAmount: "0",
            uuid: String(size),
            deadline: req.expiration,
          },
          expires_at: req.expiration,
        };
      },
    },
  } as unknown as AppContext;
}

describe("inferBook", () => {
  it("reports best bid and ask from the full ladder, not just the smallest probe", async () => {
    const book = await inferBook(makeCtx(), {
      base: "BASE",
      quote: "QUOTE",
      sizes: [100, 1_000],
      max_concurrency: 1,
    });

    expect(book.bids.map((b) => b.price)).toEqual([1, 1.1]);
    expect(book.asks[0].price).toBe(1.25);
    expect(book.asks[1].price).toBeCloseTo(1.2, 8);
    expect(book.best_bid).toBe(1.1);
    expect(book.best_ask).toBeCloseTo(1.2, 8);
    expect(book.spread_bps).toBe(870);
  });
});
