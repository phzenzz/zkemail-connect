import { Navigate, useParams } from "@tanstack/react-router";
import PagePlaceholder from "@/components/PagePlaceholder";
import { SOLUTIONS } from "./site";

export default function SolutionDetail() {
  const { slug } = useParams({ strict: false });
  const solution = SOLUTIONS.find((item) => item.slug === slug);
  if (!solution) return <Navigate to="/solutions" replace />;

  return <PagePlaceholder title={solution.title} subtitle={solution.blurb} />;
}
