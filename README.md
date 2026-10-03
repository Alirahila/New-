# My Doas App

Quranic Doas with Arabic, transliteration, meaning and recitation, behind a yearly card-payment plan.
Charcoal linen wall, pink Arabic lettering, cream Latin text. Installable as a PWA (Android Chrome, iPhone Safari "Add to Home Screen").

## What is in this version
- 38 Doas, including Surah Ad-Duha (93:1–11) and the Doas from the last part of the Qur'an (An-Nasr, Al-Falaq, An-Nas), under the "Last part of the Qur'an" filter.
- The "read from a trusted source" disclaimer is removed.
- The Doas are served by the server only after unlock (`data/doas.json`), so the app cannot be used without paying.
- One payment path: "Pay by card" opens a payment link you create yourself — **no Stripe key, no API integration, no code from me talks to any payment provider.**

## Deploy on Render
1. Replace the files in your GitHub repo with this folder's contents. **Keep the folder structure** — `server.js` and `package.json` at the top level, `public/` and `data/` as real subfolders (not flattened). If GitHub's web uploader only lets you pick files (not drag whole folders), type the path into each file's name field before committing — e.g. rename `index.html` to `public/index.html` — GitHub creates the folder from that.
2. Render service settings: Build command `npm install` (or leave empty), Start command `node server.js`.
3. Render > Environment, add:
   - `CHECKOUT_URL` — your payment link (see below)
   - `TOKEN_SECRET` — any long random string
   - `ADMIN_SECRET` — any long passphrase, protects `/admin`
   - `PRICE_LABEL` — optional, default `$16/year` — just the text on the button
4. Redeploy. Open `https://<your-app>.onrender.com/api/config` — you should see your link echoed back once `CHECKOUT_URL` is set.

## How the payment link works — and its one real limitation
"Pay by card" just opens `CHECKOUT_URL` in a new tab. **You create that link yourself**, from whichever payment provider you sign up with — this is not something I can generate without you having an account somewhere, because every provider that can actually charge a card requires its own business verification (KYC) before it processes real money. That part is true everywhere — Stripe, PayPal, Razorpay, Gumroad, all of them — it's a financial regulation, not any one company's rule.

The upside of a plain link: you don't need to give me or this app any API key at all — you paste a URL, that's it. Some places to get one, roughly easiest first:
- **Stripe Payment Links** (no code, made from the Stripe dashboard once your account is verified) — dashboard.stripe.com → Payment Links
- **PayPal.me** or a PayPal "Buy Now" button link (needs a verified PayPal *Business* account)
- **Gumroad** or **Razorpay Payment Pages** — similar no-code hosted checkout links

**The tradeoff:** because it's just a link with no API key, this server has no way to ask "did that payment actually go through?" — a plain URL gives no confirmation back. So after paying, the buyer taps **"I've paid — Unlock"** on the app and gets in immediately. This is self-reported, not verified against your bank or payment provider. Every tap is logged (timestamp + whatever note they typed) so you can check it against your provider's dashboard afterwards — open `https://<your-app>.onrender.com/admin`, enter your `ADMIN_SECRET`, and tap **Load claims**.

If a real API-verified flow (no manual step, no honor system) matters more to you than avoiding an API key, say so and I'll wire one provider's API directly the way I did before with Stripe — that path exists in an earlier version of this project, just ask.

## Known limits
- The unlock is stored on the device (browser storage). Clearing browser data, or opening the app on a second phone, asks for payment again.
- The claims log (`data/claims.json`) lives on the server's local disk. On Render's free tier that can reset on redeploy or after inactivity — fine for reconciling by hand, not a permanent record.
- Google Play: if you publish this on Google Play, Google's payments policy generally requires Google Play Billing for digital subscriptions. Check this before you submit.
