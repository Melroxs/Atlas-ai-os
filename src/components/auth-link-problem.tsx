import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import logo from "@/assets/logo.svg";
import { AlertTriangle } from "lucide-react";
import { Link } from "react-router";

/**
 * Shared "this authentication link did not work" state.
 *
 * Used by the auth callback and the password pages so an expired, already-used
 * or malformed link always ends in a clear, human-readable explanation with an
 * obvious next step — never a silent redirect to the public landing page and
 * never a raw Supabase error string.
 */
export function AuthLinkProblem({
  title,
  description,
  primary,
  secondary,
}: {
  title: string;
  description: string;
  primary: { label: string; to: string };
  secondary?: { label: string; to: string };
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex justify-center">
          <Link to="/" aria-label="Atlas home">
            <img
              src={logo}
              alt="Atlas logo"
              width={64}
              height={64}
              className="rounded-lg"
            />
          </Link>
        </div>
        <Card className="border shadow-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-amber-400/15">
              <AlertTriangle className="size-6 text-amber-600 dark:text-amber-300" />
            </div>
            <CardTitle className="text-xl">{title}</CardTitle>
            <CardDescription className="leading-relaxed">
              {description}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button asChild className="w-full">
              <Link to={primary.to}>{primary.label}</Link>
            </Button>
            {secondary ? (
              <Button asChild variant="ghost" className="w-full">
                <Link to={secondary.to}>{secondary.label}</Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
