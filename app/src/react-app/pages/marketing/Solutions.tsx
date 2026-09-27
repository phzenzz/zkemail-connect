import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SOLUTIONS } from "./site";

export default function Solutions() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20 md:py-28">
      <div className="text-center">
        <h1 className="text-5xl font-bold tracking-tight md:text-6xl">Solutions</h1>
        <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
          Ways teams use email-native token transfers.
        </p>
      </div>

      {/* 占位期整卡不可点（PRD §4.1） */}
      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {SOLUTIONS.map((solution) => (
          <Card key={solution.slug} className="h-full">
            <CardHeader>
              <div className="flex items-center justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                  <solution.icon className="h-5 w-5" />
                </span>
                <Badge variant="secondary">Coming soon</Badge>
              </div>
              <CardTitle className="pt-2">{solution.title}</CardTitle>
              <CardDescription>{solution.blurb}</CardDescription>
            </CardHeader>
            <CardContent />
          </Card>
        ))}
      </div>
    </section>
  );
}
