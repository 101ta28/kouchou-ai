import { getReportStaticParams } from "@/app/utils/report-static-params";
import { OpImage } from "../_op-image";

export const generateStaticParams = getReportStaticParams;

type PageProps = {
  params: Promise<{
    slug: string;
  }>;
};

// static build時のOGP画像生成用のroute
// ref: https://github.com/vercel/next.js/issues/51147#issuecomment-1842197049
export async function GET(_: Request, { params }: PageProps) {
  const slug = (await params).slug;
  return OpImage(slug);
}
