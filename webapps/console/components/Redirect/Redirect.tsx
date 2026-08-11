import { useEffect } from "react";
import { useRouter } from "next/router";
import { LoadingAnimation } from "../GlobalLoader/GlobalLoader";
import { captureReturnUrl, addReturnUrlToSignin } from "../../lib/auth-redirect";
import { withoutBasePath } from "../../lib/base-path";

export const Redirect: React.FC<{ href: string; title?: string }> = ({ title, href }) => {
  const router = useRouter();
  useEffect(() => {
    router.push(href);
  }, [router, href]);
  return <LoadingAnimation title={title ?? `Redirecting...`} />;
};

export const RedirectToSignIn: React.FC<{ title?: string }> = ({ title }) => {
  const router = useRouter();
  useEffect(() => {
    const returnUrl = captureReturnUrl(router);
    const signinUrlWithReturn = addReturnUrlToSignin("/signin", returnUrl);
    const signinUrl = new URL(signinUrlWithReturn, window.location.origin);
    router.push(withoutBasePath(`${signinUrl.pathname}${signinUrl.search}${signinUrl.hash}`));
  }, [router]);

  return <LoadingAnimation title={title ?? `Redirecting...`} />;
};
