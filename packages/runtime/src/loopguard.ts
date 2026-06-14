import ts from "typescript";
import { LOOP_GUARD_PREFIX } from "./loopguard-prefix";

export { LOOP_GUARD_PREFIX } from "./loopguard-prefix";

/**
 * Loop-guard transform: a build-time AST pass that injects an iteration budget
 * into every loop in a content file. A `while (true) {}` (or any runaway loop)
 * then *throws* the moment it blows the budget instead of wedging the single
 * render thread forever — and a throw is something the engine already contains
 * (NFR-2: a render-time throw freezes that instance, the loop keeps ticking).
 * It turns the "never halts" failure mode into the "never go black" one.
 *
 * The guard is **count-based, not time-based, on purpose**: a per-loop counter
 * gives the same throw/no-throw decision on every machine and every replay, so
 * deterministic fixture playback (byte-identical `screenshot({frames})`) is
 * preserved. A wall-clock deadline would make a loop's fate depend on CPU speed.
 *
 * Each loop gets its OWN counter, reset on entry, so a big-but-finite loop is
 * fine, nested loops each get a fresh budget, and a loop re-entered every frame
 * never accumulates across frames. Only genuinely unbounded iteration trips it.
 */

/**
 * Default iterations a single loop entry may run before the guard throws. High
 * enough that no legitimate content loop (shader builders, small arrays) is at
 * risk; low enough that a true infinite loop dies in well under a frame.
 */
export const DEFAULT_LOOP_BUDGET = 5_000_000;

export interface LoopGuardOpts {
  /** Per-loop-entry iteration cap (default {@link DEFAULT_LOOP_BUDGET}). */
  budget?: number;
  /** Source file name (diagnostics only). */
  fileName?: string;
}

/** Recognize a Loop-budget throw (by message prefix) anywhere it surfaces. */
export function isLoopBudgetError(err: unknown): boolean {
  return (
    err instanceof Error &&
    typeof err.message === "string" &&
    err.message.startsWith(LOOP_GUARD_PREFIX)
  );
}

const isLoop = (n: ts.Node): n is ts.IterationStatement =>
  ts.isForStatement(n) ||
  ts.isForOfStatement(n) ||
  ts.isForInStatement(n) ||
  ts.isWhileStatement(n) ||
  ts.isDoStatement(n);

/**
 * Rewrite `code` so every loop carries an iteration budget. Returns equivalent
 * TypeScript with guards injected (types preserved; esbuild strips them later).
 * Pure and synchronous — safe to call from a Vite `transform` hook or a test.
 */
export function injectLoopGuards(code: string, opts: LoopGuardOpts = {}): string {
  const budget = opts.budget ?? DEFAULT_LOOP_BUDGET;
  const fileName = opts.fileName ?? "input.ts";
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const f = context.factory;
    let counterN = 0;

    // `if (++counter > budget) throw new Error("…")`
    const guardStmt = (counter: ts.Identifier): ts.Statement =>
      f.createIfStatement(
        f.createBinaryExpression(
          f.createPrefixUnaryExpression(ts.SyntaxKind.PlusPlusToken, counter),
          f.createToken(ts.SyntaxKind.GreaterThanToken),
          f.createNumericLiteral(budget),
        ),
        f.createThrowStatement(
          f.createNewExpression(f.createIdentifier("Error"), undefined, [
            f.createStringLiteral(
              `${LOOP_GUARD_PREFIX}a loop exceeded ${budget} iterations (likely runaway/infinite)`,
            ),
          ]),
        ),
      );

    // `let counter = 0;`
    const counterDecl = (counter: ts.Identifier): ts.Statement =>
      f.createVariableStatement(
        undefined,
        f.createVariableDeclarationList(
          [f.createVariableDeclaration(counter, undefined, undefined, f.createNumericLiteral(0))],
          ts.NodeFlags.Let,
        ),
      );

    // Re-emit a loop with its body forced to a block whose first statement is
    // the guard. The loop's children are already visited by the caller.
    const withGuardedBody = (
      loop: ts.IterationStatement,
      counter: ts.Identifier,
    ): ts.IterationStatement => {
      const body = loop.statement;
      const inner = ts.isBlock(body) ? body.statements : [body];
      const guarded = f.createBlock([guardStmt(counter), ...inner], true);
      if (ts.isForStatement(loop))
        return f.updateForStatement(loop, loop.initializer, loop.condition, loop.incrementor, guarded);
      if (ts.isForOfStatement(loop))
        return f.updateForOfStatement(loop, loop.awaitModifier, loop.initializer, loop.expression, guarded);
      if (ts.isForInStatement(loop))
        return f.updateForInStatement(loop, loop.initializer, loop.expression, guarded);
      if (ts.isWhileStatement(loop)) return f.updateWhileStatement(loop, loop.expression, guarded);
      return f.updateDoStatement(loop as ts.DoStatement, guarded, (loop as ts.DoStatement).expression);
    };

    const visit = (node: ts.Node): ts.Node => {
      // A labeled loop (`outer: for …`): keep the label ON the loop so
      // `break/continue outer` still resolve, and put the counter in a block
      // wrapping the whole labeled statement.
      if (ts.isLabeledStatement(node) && isLoop(node.statement)) {
        const visited = ts.visitEachChild(node.statement, visit, context) as ts.IterationStatement;
        const counter = f.createIdentifier(`__loomLoop${counterN++}`);
        const labeled = f.updateLabeledStatement(node, node.label, withGuardedBody(visited, counter));
        return f.createBlock([counterDecl(counter), labeled], true);
      }
      if (isLoop(node)) {
        const visited = ts.visitEachChild(node, visit, context) as ts.IterationStatement;
        const counter = f.createIdentifier(`__loomLoop${counterN++}`);
        return f.createBlock([counterDecl(counter), withGuardedBody(visited, counter)], true);
      }
      return ts.visitEachChild(node, visit, context);
    };

    return (root) => ts.visitNode(root, visit) as ts.SourceFile;
  };

  const result = ts.transform(sf, [transformer]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const out = printer.printFile(result.transformed[0]!);
  result.dispose();
  return out;
}
