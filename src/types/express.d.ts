import type { Claims } from "../modules/auth/types.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      /** Set by the authenticate middleware. */
      claims?: Claims;
    }
  }
}

export {};
