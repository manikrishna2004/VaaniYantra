// Phone-number normalization. Telephony providers hand us caller ids in mixed
// formats — Twilio uses E.164 ("+919346…"), Exotel often sends local Indian
// forms ("09346…", "9346…") — while the Twilio/Meta messaging APIs strictly
// require E.164 (a raw "+0934…" is rejected with error 21211). India is the
// platform's home market, so bare 10-digit mobiles assume +91.
export function toE164(raw: string | null | undefined, defaultCc = '91'): string | null {
  if (!raw) return null;
  const s = String(raw).replace(/^whatsapp:/i, '').trim();
  if (/^\+[1-9]\d{6,14}$/.test(s)) return s;
  const digits = s.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+${defaultCc}${digits}`;
  return `+${digits}`;
}
