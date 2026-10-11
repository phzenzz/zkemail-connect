import { Badge } from "@/components/ui/badge";

/** 营销占位页统一模板：居中单栏，标题 + 副标题 + Coming soon（PRD §4.1）。 */
export default function PagePlaceholder({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20 text-center md:py-28">
      <h1 className="text-5xl font-bold tracking-tight md:text-6xl">{title}</h1>
      <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
        {subtitle}
      </p>
      <div className="mt-8 flex justify-center">
        <Badge variant="secondary">Coming soon</Badge>
      </div>
    </section>
  );
}
