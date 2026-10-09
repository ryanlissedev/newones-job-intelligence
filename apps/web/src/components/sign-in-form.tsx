import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

import { SignInFormView } from "./sign-in-form-view";

export default function SignInForm() {
  const router = useRouter();

  return (
    <SignInFormView
      onSubmit={async ({ email, password }) => {
        await authClient.signIn.email(
          { email, password },
          {
            onError: (error) => {
              toast.error(error.error.message || error.error.statusText);
            },
            onSuccess: () => {
              router.push("/dashboard");
              toast.success("Sign in successful");
            },
          }
        );
      }}
    />
  );
}
