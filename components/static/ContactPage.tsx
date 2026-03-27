

import React, { useEffect } from 'react';
import { Card } from '../common/Card';

const ContactPage: React.FC = () => {
    useEffect(() => {
        window.scrollTo(0, 0);
    }, []);

    const supportEmail = "devnexus47@gmail.com";

    return (
        <div className="max-w-3xl mx-auto pt-24 pb-8 px-4">
            <Card title="Contact Us" className="bg-white dark:bg-zinc-900 shadow-lg border border-gray-200 dark:border-zinc-700">
                <div className="prose prose-sm sm:prose lg:prose-lg xl:prose-xl max-w-none text-gray-600 dark:text-gray-300 space-y-6">
                    <p>We're here to help! If you have any questions, issues, or feedback regarding the EzyPrint service, please don't hesitate to get in touch with us.</p>

                    <div>
                        <h3 className="text-lg font-semibold text-brand-primary mb-2">General Inquiries & Support</h3>
                        <p>For all support requests, questions about your orders, or issues with the platform, please reach out to our support team.</p>
                        <ul className="list-none pl-0 space-y-2 mt-2">
                            <li className="flex items-center">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-brand-primary" viewBox="0 0 20 20" fill="currentColor">
                                    <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
                                    <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
                                </svg>
                                <span>Email: <a href={`mailto:${supportEmail}`} className="text-brand-primary hover:underline">{supportEmail}</a></span>
                            </li>
                        </ul>
                    </div>

                    <div>
                        <h3 className="text-lg font-semibold text-brand-primary mb-2">Operating Address</h3>
                        <p>EzyPrint by Harshvardhan<br />
                            Lovely Professional University<br />
                            Jalandhar - Delhi, Grand Trunk Rd<br />
                            Phagwara, Punjab 144411<br />
                            India</p>
                    </div>

                    <div>
                        <h3 className="text-lg font-semibold text-brand-primary mb-2">Feedback</h3>
                        <p>We value your feedback to improve EzyPrint. Please feel free to share your thoughts and suggestions with us at the support email address mentioned above.</p>
                    </div>
                </div>
            </Card>
        </div>
    );
};

export default ContactPage;
