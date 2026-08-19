
import React, { useEffect } from 'react';
import { Card } from '../common/Card';

/**
 * Every statement here has to be true of the system as deployed today.
 *
 * The previous version described a different application in three places: it
 * said uploaded documents were not kept "longer than necessary", that bank
 * details lived in "local storage" because this was a "demo", and that users
 * could delete their personal information. None of those matched the code. It
 * also stamped "Last Updated" with `new Date()`, so it claimed to have been
 * revised today no matter how long it had been stale — which is the one field
 * a reader uses to decide whether the terms changed.
 *
 * A privacy policy that describes an intended system rather than the running
 * one is not a rounding error; it is the document with legal weight. Where
 * behaviour is imperfect — files on abandoned orders, deletion blocked for
 * accounts with financial history — it says so plainly rather than describing
 * the version that ships later.
 */
const LAST_UPDATED = '19 August 2026';

const PrivacyPolicyPage: React.FC = () => {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="max-w-3xl mx-auto pt-24 pb-8 px-4">
      <Card title="Privacy Policy" className="bg-brand-secondary/80 backdrop-blur-sm">
        <div className="prose prose-sm sm:prose lg:prose-lg xl:prose-xl max-w-none text-brand-lightText space-y-4">
          <p><strong>Last Updated: {LAST_UPDATED}</strong></p>

          <h2 className="text-brand-primary">1. Introduction</h2>
          <p>Welcome to EzyPrint ("we," "our," or "us"). We are committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our application.</p>

          <h2 className="text-brand-primary">2. Information We Collect</h2>
          <p>We may collect personal information such as:</p>
          <ul>
            <li>Name, email address, user type (Student/Shop Owner).</li>
            <li>Documents you upload for printing. See section 5 for exactly how long these are kept.</li>
            <li>Order details, including print options, the shop selected, page counts and amounts charged.</li>
            <li>Payment records from Razorpay — payment and refund identifiers and amounts. We never receive or store your full card number, UPI PIN, or bank credentials; those are handled entirely by Razorpay.</li>
            <li>Shop details provided by Shop Owners, including shop name, address, pricing, and payout details (bank account or UPI).</li>
            <li>A device notification token, if you use the Android app and allow notifications, so we can tell you when your order is ready.</li>
            <li>Technical data collected automatically: IP address, browser or device type, and timestamps. We use these for security, abuse prevention and rate limiting.</li>
          </ul>

          <h2 className="text-brand-primary">3. How We Use Your Information</h2>
          <p>We use the information we collect to:</p>
          <ul>
            <li>Provide, operate, and maintain our services.</li>
            <li>Process your print orders and facilitate payments and refunds.</li>
            <li>Manage your account and provide customer support.</li>
            <li>Communicate with you about your orders or important updates.</li>
            <li>Enable shop owners to manage their services and receive payouts.</li>
            <li>Keep financial records of payments, refunds and shop earnings.</li>
            <li>Improve our application and user experience.</li>
            <li>Comply with legal obligations.</li>
          </ul>

          <h2 className="text-brand-primary">4. Sharing Your Information</h2>
          <p>We may share your information with:</p>
          <ul>
            <li>The print shop you selected — it receives your name, your order details and the document you uploaded, because it has to print it.</li>
            <li>Razorpay, our payment processor, to take payments and issue refunds.</li>
            <li>Service providers who host and operate the application on our behalf, including our database, file storage, email and notification providers.</li>
            <li>Legal authorities if required by law.</li>
          </ul>
          <p>We do not sell your personal information to third parties.</p>

          <h2 className="text-brand-primary">5. Uploaded Documents and Retention</h2>
          <p>Your documents are stored with a third-party object storage provider and are shared with the print shop you chose. We delete them as follows:</p>
          <ul>
            <li><strong>When your order finishes.</strong> Once an order is Completed, Cancelled or Refunded, the file is deleted automatically — normally within minutes.</li>
            <li><strong>While a dispute is open.</strong> If you have raised a refund request or a support ticket about an order, the file is kept until that is resolved, because it is the only record of what was actually sent to the shop. It is deleted once the dispute closes.</li>
            <li><strong>Orders that never finish.</strong> If an order never reaches one of those final states — most commonly an order you uploaded but never paid for — its file is currently retained rather than deleted. We are changing this so that unpaid orders are cancelled and their files deleted automatically. Until that ships, you can cancel such an order yourself from your order list, which deletes the file.</li>
          </ul>
          <p>Order records themselves — amounts, dates, statuses — are retained after the document is deleted, because they are financial records.</p>

          <h2 className="text-brand-primary">6. Data Security</h2>
          <p>We implement reasonable security measures to protect your information. However, no electronic transmission or storage is 100% secure.</p>
          <p>Shop payout details (bank account or UPI) are stored in our production database, not on your device. Access is restricted to the shop owner they belong to and to administrators, every access is recorded in an audit log, and account numbers are masked to all but administrators. All traffic between the app and our servers is encrypted in transit.</p>

          <h2 className="text-brand-primary">7. Your Data Rights</h2>
          <p>You may have rights to access, correct, or delete your personal information, subject to applicable laws.</p>
          <ul>
            <li><strong>Access and correction.</strong> You can view and edit your profile in the app, or contact us.</li>
            <li><strong>Deletion.</strong> You can delete your account from the app. If your account has payment or earnings history, deletion is currently refused, because those orders are attached to financial records we are required to keep and removing the account would destroy them. We are implementing a process that erases your personal details while retaining only the financial record. Until then, please contact us and we will handle the request manually.</li>
          </ul>
          <p>We will always tell you what has been erased and what has been retained, rather than describing a request as fully completed when records remain.</p>

          <h2 className="text-brand-primary">8. Cookies and Tracking Technologies</h2>
          <p>We store a sign-in token in your browser or app so that you stay logged in. We do not use advertising or third-party tracking cookies.</p>

          <h2 className="text-brand-primary">9. Changes to This Policy</h2>
          <p>We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new policy on this page and updating the date at the top.</p>

          <h2 className="text-brand-primary">10. Contact Us</h2>
          <p>If you have any questions about this Privacy Policy, or to make a data request, please contact us through the "Contact Us" page.</p>

        </div>
      </Card>
    </div>
  );
};

export default PrivacyPolicyPage;
