import worker, { type Env } from "../src/actions-worker";

export const onRequest: PagesFunction<Env> = async (context) => {
  return worker.fetch(
    context.request,
    context.env,
    context as unknown as ExecutionContext,
  );
};
