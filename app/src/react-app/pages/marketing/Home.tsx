import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { LAUNCH_APP } from "./site";

export default function Home() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20 text-center md:py-28">
      <h1 className="mx-auto max-w-3xl text-5xl font-bold tracking-tight md:text-6xl">
        Send crypto to any email address
      </h1>
      <p className="mx-auto mt-5 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
        The recipient replies to an email to claim. No seed phrases, no onboarding.
      </p>
      <div className="mt-8 flex justify-center">
        <Button asChild size="lg">
          <Link to={LAUNCH_APP}>Launch App</Link>
        </Button>
      </div>
    </section>
  );
}
