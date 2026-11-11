import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PublicFooter, PublicNav } from "../components/PublicChrome";
import SkyCanvas from "../components/SkyCanvas";
import { useMeta } from "./Blog";
import "../styles/legal.css";

const UPDATED = "November 10, 2026";

function LegalPage({ eyebrow, title, description, children }: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  useMeta(`${title} | Notestack`, description);
  return (
    <div className="page legal-page">
      <SkyCanvas intensity={0.45} />
      <PublicNav />
      <main className="container legal-shell">
        <header className="legal-head">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="muted">Last updated: {UPDATED}</p>
        </header>
        <article className="legal-copy">{children}</article>
      </main>
      <PublicFooter />
    </div>
  );
}

export function PrivacyPolicy() {
  return (
    <LegalPage
      eyebrow="Your data"
      title="Privacy policy"
      description="Learn how Notestack collects, uses, and protects your personal information."
    >
      <section>
        <h2>1. Introduction</h2>
        <p>
          Firebird Technologies ("we", "us", or "our") operates Notestack at
          {" "}<a href="https://notestack.ai">notestack.ai</a> (the "Service"). This Privacy Policy explains how we
          collect, use, disclose, and protect your information when you use the Service.
        </p>
      </section>

      <section>
        <h2>2. Information we collect</h2>
        <h3>Account information</h3>
        <p>
          When you create an account, we collect your name, email address, authentication details, subscription plan, and
          preferences. If you sign in with Google, we may also receive your Google profile image. If you sign in with Apple, we receive your name (the first time only) and either your email address or a private relay address from Apple that forwards to it.
        </p>
        <h3>User content</h3>
        <p>
          We collect and process the content you submit to the Service, including sources, URLs, uploaded files, notes,
          notebooks, questions, chats, generated artifacts, feedback, and support messages. If you choose voice cloning,
          we also process your consent and voice sample.
        </p>
        <h3>Connection and usage data</h3>
        <p>
          We collect authorised app scopes, encrypted connection tokens, pages visited, features used, timestamps, IP
          address, browser type, device identifiers, and error or security logs.
        </p>
        <h3>Payment information</h3>
        <p>
          Payment transactions are processed by our third-party payment processor on the web, and by Apple (App Store) or
          Google (Google Play) for subscriptions bought in our mobile apps. We receive the subscription's status, not your
          payment details, and we do not store full payment-card details on our servers.
        </p>
      </section>

      <section>
        <h2>3. How we use your information</h2>
        <p>We use the information we collect to:</p>
        <ul>
          <li>Provide, operate, and improve the Service.</li>
          <li>Import and organise sources and generate the output you request.</li>
          <li>Operate connected apps and MCP access authorised by you.</li>
          <li>Process transactions and manage your subscription.</li>
          <li>Send transactional and service-related communications.</li>
          <li>Respond to support requests and inquiries.</li>
          <li>Monitor for abuse and enforce our Terms of Service.</li>
          <li>Analyse usage patterns to improve features and performance.</li>
          <li>Comply with legal obligations.</li>
        </ul>
      </section>

      <section>
        <h2>4. Third-party services</h2>
        <p>
          We use trusted third-party providers to help operate the Service, including:
        </p>
        <ul>
          <li><strong>Identity providers</strong> for account authentication.</li>
          <li><strong>Payment processors</strong> for billing and subscription management.</li>
          <li><strong>Cloud infrastructure providers</strong> for hosting and storage.</li>
          <li><strong>AI, speech, web-import, and media providers</strong> for features you request.</li>
          <li><strong>Analytics providers</strong>, including Google Analytics and Google Analytics for Firebase, for usage analysis.</li>
          <li><strong>Email providers</strong> for communications.</li>
          <li><strong>Connected apps and MCP clients</strong> when you authorise access.</li>
        </ul>
        <p>
          These providers receive only information necessary to perform their functions and are subject to their own
          privacy policies. ChatGPT or another MCP client receives only the information and actions covered by the
          permissions you approve. You can revoke supported connections in Settings. We do not sell personal data, and we
          do not use workspace content for model training unless you enable the training opt-in setting.
        </p>
      </section>

      <section>
        <h2>5. Data retention</h2>
        <p>
          We retain your account information and User Content for as long as your account is active or as needed to provide
          the Service. You may delete content or request deletion of your account. We may retain certain information as
          required by law or for legitimate security, billing, dispute, or backup purposes. When you delete your account,
          it is closed and your public links stop working at once, and your notebooks, sources, uploads, chats, generated
          content, voice samples and connections are permanently deleted within 30 days. After that we keep only a minimal
          record of the account (its email address and the dates it was created and deleted) so it is not reused or
          recreated by mistake; it is not used for anything else. See <Link to="/delete-account">how to delete your
          account</Link>. Unfinished uploads and
          verification records are normally removed after one day. MCP access tokens normally expire after one hour and
          refresh access after 30 days.
        </p>
      </section>

      <section>
        <h2>6. Data security</h2>
        <p>
          We implement reasonable technical and organisational measures to protect your information against unauthorised
          access, loss, or disclosure. However, no method of transmission over the internet is completely secure, and we
          cannot guarantee absolute security.
        </p>
      </section>

      <section>
        <h2>7. Your rights</h2>
        <p>Depending on your location, you may have the right to:</p>
        <ul>
          <li>Access the personal information we hold about you.</li>
          <li>Request correction of inaccurate data.</li>
          <li>Request deletion of your personal data.</li>
          <li>Object to or restrict certain processing.</li>
          <li>Receive a portable copy of your data where applicable.</li>
        </ul>
        <p>
          You can also manage connected apps, public links, email preferences, privacy choices, and account deletion in
          Settings. To exercise other rights, contact us using the address below.
        </p>
      </section>

      <section>
        <h2>8. Cookies and analytics</h2>
        <p>
          We use cookies, local storage, session storage, and similar technologies to operate the Service, maintain sign-in,
          remember preferences, preserve temporary workflow state, and analyse usage. You can control these technologies
          through your browser settings, though disabling them may affect Service functionality.
        </p>
        <p>
          Our website uses Google Analytics. Our iOS and Android apps use Google Analytics for Firebase, which records the
          screens you view, the features you use, in-app purchase activity, your app version, device and operating system
          details, approximate location, and an app instance identifier, linked to an internal account identifier. It does
          not receive what you write, import, or generate, and the apps do not collect advertising identifiers. You can turn
          app analytics off at any time in the app under Settings, Privacy and email.
        </p>
      </section>

      <section>
        <h2>9. Children's privacy</h2>
        <p>
          The Service is not directed to children under 18. We do not knowingly collect personal information from anyone
          under 18. If you believe we have inadvertently collected such information, contact us and we will delete it
          promptly.
        </p>
      </section>

      <section>
        <h2>10. Changes to this policy</h2>
        <p>
          We may update this Privacy Policy from time to time. We will notify you of material changes by updating the "Last
          updated" date above or by emailing your registered address. Your continued use of the Service after changes take
          effect constitutes your acceptance of the updated Policy.
        </p>
      </section>

      <section>
        <h2>11. Contact us</h2>
        <p>
          If you have questions or concerns about this Privacy Policy, contact us at
          {" "}<a href="mailto:arslan@firebird-technologies.com">arslan@firebird-technologies.com</a>.
        </p>
      </section>
    </LegalPage>
  );
}

export function TermsOfService() {
  return (
    <LegalPage
      eyebrow="Using Notestack"
      title="Terms of service"
      description="Read the Terms of Service for Notestack, the AI research and content workspace by Firebird Technologies."
    >
      <section>
        <h2>1. Agreement to terms</h2>
        <p>
          By accessing or using Notestack at <a href="https://notestack.ai">notestack.ai</a> (the "Service"), you agree
          to be bound by these Terms of Service ("Terms"). The Service is operated by Firebird Technologies ("we",
          "us", or "our"). If you do not agree to these Terms, do not use the Service.
        </p>
      </section>

      <section>
        <h2>2. Description of service</h2>
        <p>
          Notestack is an AI-powered research and content workspace. It lets you import and organise sources in notebooks,
          ask questions, and create reports, podcasts, presentations, videos, mind maps, and other outputs. Features may
          also include connected apps, publishing tools, and MCP access for ChatGPT and other compatible clients.
        </p>
      </section>

      <section>
        <h2>3. Accounts</h2>
        <p>
          You must create an account to access most features. You are responsible for maintaining the confidentiality of
          your account credentials and for all activity that occurs under your account. You must be at least 18 years old
          to use the Service. You agree to provide accurate, current, and complete information during registration and to
          update such information as needed.
        </p>
      </section>

      <section>
        <h2>4. Subscriptions and payment</h2>
        <p>
          Certain features of the Service require a paid subscription. By subscribing, you agree to pay the applicable
          fees described on our Pricing page. Subscriptions renew automatically unless cancelled before the renewal date.
          You may cancel your subscription at any time through your account settings. A subscription bought in our iOS or
          Android app is billed by Apple or Google, and is managed and cancelled in your App Store or Google Play account
          settings; their refund terms apply to it. Fees are non-refundable except where
          required by applicable law or otherwise stated in our refund policy. We reserve the right to change pricing with
          reasonable notice.
        </p>
      </section>

      <section>
        <h2>5. Your content</h2>
        <p>
          You retain all ownership rights to the sources, files, prompts, recordings, and other content you submit to the
          Service ("User Content"). By submitting User Content, you grant us a limited, non-exclusive, royalty-free licence
          to process, store, and transform that content solely to provide the Service and as allowed by the privacy choices
          you enable.
        </p>
        <p>
          You represent and warrant that: (a) you own or have the necessary rights to the User Content you submit; (b) the
          User Content does not infringe any third-party intellectual-property, privacy, publicity, or other rights; (c) you
          have informed consent for any voice sample you ask us to clone; and (d) the User Content complies with these Terms
          and all applicable laws.
        </p>
      </section>

      <section>
        <h2>6. AI-generated output</h2>
        <p>
          Answers, reports, audio, presentations, videos, images, and other outputs generated by the Service are derived
          from your User Content and instructions using AI models. You are solely responsible for reviewing AI-generated
          output before relying on, publishing, or distributing it. We do not guarantee the accuracy, completeness,
          originality, or fitness of AI-generated content for any particular purpose. Connected services, including
          ChatGPT and other MCP clients, are also subject to their own terms.
        </p>
      </section>

      <section>
        <h2>7. Prohibited uses</h2>
        <p>You agree not to use the Service to:</p>
        <ul>
          <li>Infringe any third-party intellectual-property, privacy, publicity, or other rights.</li>
          <li>Generate or distribute misleading, defamatory, abusive, or harmful content.</li>
          <li>Clone or imitate a person's voice without that person's informed consent.</li>
          <li>Attempt to reverse engineer, scrape, bypass limits, or exploit the Service.</li>
          <li>Access another person's account or connected service without permission.</li>
          <li>Violate any applicable law or regulation.</li>
          <li>Transmit viruses, malware, or other harmful code.</li>
          <li>Harass, abuse, or harm any person or entity.</li>
        </ul>
      </section>

      <section>
        <h2>8. Intellectual property</h2>
        <p>
          The Service, including its design, code, trademarks, and all content we create, is owned by Firebird Technologies
          and protected by applicable intellectual-property laws. Nothing in these Terms grants you any right to use our
          trademarks or branding without our prior written consent.
        </p>
      </section>

      <section>
        <h2>9. Termination</h2>
        <p>
          We may suspend or terminate your access to the Service at any time for violation of these Terms or for any other
          reason at our discretion, with or without notice. You may terminate your account at any time through your account
          settings or by contacting us. Upon termination, your right to use the Service ceases immediately.
        </p>
      </section>

      <section>
        <h2>10. Disclaimers</h2>
        <p>
          THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED,
          INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT. WE DO NOT
          WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF HARMFUL COMPONENTS.
        </p>
      </section>

      <section>
        <h2>11. Limitation of liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, FIREBIRD TECHNOLOGIES SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
          SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES, ARISING OUT OF OR RELATED TO
          YOUR USE OF THE SERVICE. OUR AGGREGATE LIABILITY SHALL NOT EXCEED THE AMOUNTS PAID BY YOU TO US IN THE THREE
          MONTHS PRECEDING THE CLAIM.
        </p>
      </section>

      <section>
        <h2>12. Changes to terms</h2>
        <p>
          We may update these Terms from time to time. We will notify you of material changes by updating the "Last
          updated" date above or by sending an email to your registered address. Your continued use of the Service after
          changes are posted constitutes your acceptance of the updated Terms.
        </p>
      </section>

      <section>
        <h2>13. Governing law</h2>
        <p>
          These Terms are governed by and construed in accordance with applicable law. Any disputes shall be resolved in
          the competent courts of the jurisdiction in which Firebird Technologies operates.
        </p>
      </section>

      <section>
        <h2>14. Contact</h2>
        <p>
          If you have questions about these Terms, contact us at
          {" "}<a href="mailto:arslan@firebird-technologies.com">arslan@firebird-technologies.com</a>. Read our
          {" "}<Link to="/privacy">privacy policy</Link>.
        </p>
      </section>
    </LegalPage>
  );
}

export function SupportPage() {
  return (
    <LegalPage
      eyebrow="Help center"
      title="Support"
      description="Get help with your Notestack account, integrations, or content."
    >
      <section>
        <h2>Contact us</h2>
        <p>
          Email <a href="mailto:arslan@firebird-technologies.com">arslan@firebird-technologies.com</a> with your account email, what happened, and any
          error message. Never send passwords, payment-card numbers, API keys, or access tokens.
        </p>
      </section>
      <section>
        <h2>Account and privacy requests</h2>
        <p>
          You can manage connected apps, privacy choices, and account deletion in Settings. Read our
          {" "}<Link to="/privacy">privacy policy</Link> or <Link to="/terms">terms of service</Link>.
        </p>
      </section>
    </LegalPage>
  );
}

export function DeleteAccountPage() {
  return (
    <LegalPage
      eyebrow="Your data"
      title="Delete your account"
      description="How to delete your Notestack account and what happens to your data."
    >
      <section>
        <h2>In the app</h2>
        <ol>
          <li>Open Notestack on iPhone, iPad or Android, and sign in.</li>
          <li>Open the menu, then <strong>Settings</strong>.</li>
          <li>Under <strong>Account</strong>, tap <strong>Delete account</strong> and confirm.</li>
        </ol>
      </section>
      <section>
        <h2>On the web</h2>
        <p>
          Sign in at <a href="https://notestack.ai/app/settings">notestack.ai</a>, open <strong>Settings</strong>, and
          choose <strong>Delete account</strong> under Account.
        </p>
      </section>
      <section>
        <h2>What is deleted</h2>
        <p>
          Your account is closed at once: you are signed out everywhere and your public links stop working. Within 30
          days your notebooks, sources, uploads, chats, generated content, voice samples and connected apps are
          permanently deleted. We keep only a minimal record of the account (its email address and the dates it was
          created and deleted). Read our <Link to="/privacy">privacy policy</Link> for details.
        </p>
      </section>
      <section>
        <h2>Subscriptions</h2>
        <p>
          Deleting your account does not cancel a subscription bought through the App Store: cancel it in your Apple ID
          settings first. Subscriptions bought on the web or through Google Play end with the account.
        </p>
      </section>
      <section>
        <h2>Can't sign in?</h2>
        <p>
          Email <a href="mailto:arslan@firebird-technologies.com">arslan@firebird-technologies.com</a> from the address
          on your account, and we will delete it for you.
        </p>
      </section>
    </LegalPage>
  );
}
