import { onRequest } from "firebase-functions/v2/https";
import app from "./server.js";

export const api = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  app
);
