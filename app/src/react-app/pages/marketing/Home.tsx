import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import FlowBackground from "@/components/marketing/FlowBackground";
import { LAUNCH_APP } from "./site";

export default function Home() {
  return (
    <section className="relative flex min-h-[calc(100vh-3.5rem)] items-center overflow-hidden">
      <FlowBackground />
      <div className="relative mx-auto w-full max-w-6xl px-6 py-20 text-center md:py-28">
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
      </div>
    </section>
  );
}
