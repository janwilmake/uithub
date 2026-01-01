import Stripe from "stripe";
import { Env, getUserAccount, setUserAccount, UserAccount } from "./auth";

// ==================== STRIPE WEBHOOK HANDLER ====================

const streamToBuffer = async (
  readableStream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  const reader = readableStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }
  return result;
};

export async function handleStripeWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!request.body) {
    return Response.json({ error: "No body" }, { status: 400 });
  }

  const rawBody = await streamToBuffer(request.body);
  const rawBodyString = new TextDecoder().decode(rawBody);

  const stripe = new Stripe(env.STRIPE_SECRET, {
    apiVersion: "2025-11-17.clover",
  });

  const stripeSignature = request.headers.get("stripe-signature");
  if (!stripeSignature) {
    return Response.json({ error: "No signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBodyString,
      stripeSignature,
      env.STRIPE_WEBHOOK_SIGNING_SECRET,
    );
  } catch (err: any) {
    console.log("Webhook error:", err.message);
    return new Response(`Webhook error: ${String(err)}`, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    if (session.payment_link !== env.STRIPE_PAYMENT_LINK_ID) {
      return new Response("Incorrect payment link", { status: 200 });
    }

    if (session.payment_status !== "paid" || !session.amount_subtotal) {
      return new Response("Payment not completed", { status: 400 });
    }

    const { client_reference_id, amount_subtotal } = session;

    if (!client_reference_id) {
      return new Response("Missing client_reference_id", { status: 400 });
    }

    const userId = client_reference_id;
    const account = await getUserAccount(userId, env);

    if (account) {
      account.credit += amount_subtotal;
      await setUserAccount(userId, account, env);
    } else {
      const newAccount: UserAccount = {
        credit: amount_subtotal,
        username: "",
        profile_picture: "",
        private_granted: false,
        premium: false,
      };
      await setUserAccount(userId, newAccount, env);
    }

    return new Response("Payment processed successfully", { status: 200 });
  }

  return new Response("Event not handled", { status: 200 });
}
