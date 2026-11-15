import type { Decision, ReasonCode, ReplyDraft } from '../types.js';

export interface ReplyContext {
  decision: Decision;
  customerFirstName: string | null;
  refundAmount: number | null;
  currency: 'EUR';
  transactionDescription: string | null;
  reasonCodes: ReasonCode[];
  estimatedDeliveryAt: string | null;
}

/** Customer-safe explanations. Never expose internal rule ids or risk signals. */
const CUSTOMER_REASON: Partial<Record<ReasonCode, string>> = {
  OUTSIDE_REFUND_WINDOW: 'the request was received after the refund period for this purchase ended',
  ALREADY_REFUNDED: 'this purchase has already been refunded',
  REFUND_ALREADY_APPROVED: 'a refund for this purchase has already been approved',
  CHARGEBACK_IN_PROGRESS: 'there is an open dispute with your bank for this payment, which will be resolved through that process',
  SHIPMENT_STILL_IN_TRANSIT: 'your parcel is still on its way',
  TRANSACTION_NOT_FOUND: 'we could not find this purchase on the account linked to your email address',
  AMBIGUOUS_TRANSACTION: 'we could not tell which purchase your request is about',
  CUSTOMER_NOT_FOUND: 'we could not find an account linked to this email address',
};

const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Deterministic reply used by the mock LLM and as a safe fallback when the LLM draft fails checks. */
export function renderTemplateReply(ctx: ReplyContext): ReplyDraft {
  const hello = `Hello ${ctx.customerFirstName ?? 'there'},`;
  const desc = ctx.transactionDescription;
  const item = desc ? ` your ${desc.charAt(0).toLowerCase()}${desc.slice(1)}` : ' your purchase';
  const why = ctx.reasonCodes.map((r) => CUSTOMER_REASON[r]).find(Boolean);
  const sign = '\n\nKind regards,\nCustomer Care Team';

  switch (ctx.decision) {
    case 'AUTO_APPROVE':
      return {
        subject: 'Your refund has been approved',
        body: `${hello}\n\nThank you for letting us know. We have approved a refund of ${ctx.refundAmount?.toFixed(2)} ${ctx.currency} for${item}. It will be returned to your original payment method within 5-7 business days.${sign}`,
      };
    case 'ESCALATE':
      return {
        subject: 'We are reviewing your refund request',
        body: `${hello}\n\nThank you for your message about${item}. A specialist from our team will review your request and get back to you within 2 business days. You don't need to do anything else for now.${sign}`,
      };
    case 'REJECT': {
      const wait =
        ctx.reasonCodes.includes('SHIPMENT_STILL_IN_TRANSIT') && ctx.estimatedDeliveryAt
          ? ` It is expected to arrive by ${fmtDate(ctx.estimatedDeliveryAt)}. If it has not arrived by then, just reply to this email and we will look into it right away.`
          : ' If you believe this is a mistake, reply to this email and a member of our team will take another look.';
      return {
        subject: 'About your refund request',
        body: `${hello}\n\nThank you for contacting us about${item}. We are unable to issue a refund at this time because ${why ?? 'the request does not meet our refund policy'}.${wait}${sign}`,
      };
    }
    case 'NEED_MORE_INFO':
      return {
        subject: 'We need a bit more information',
        body: `${hello}\n\nThank you for your message. Unfortunately ${why ?? 'we need more details to process your request'}. Please reply with the order or transaction number shown in your confirmation email, and make sure you write to us from the email address used for the purchase.${sign}`,
      };
    case 'REFUSED':
      return {
        subject: 'How we can help',
        body: `${hello}\n\nThanks for reaching out. This inbox handles refunds, returns and billing questions for your orders, so we are not able to help with this request. If you have a question about a purchase, just reply with the details.${sign}`,
      };
    case 'INVALID_INPUT':
      return {
        subject: 'We could not process your request',
        body: `${hello}\n\nWe could not process your request because some required information was missing or invalid. Please check the details and try again.${sign}`,
      };
  }
}
