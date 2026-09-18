import { createInterface } from 'node:readline';

import { evaluateReplay, type EvaluationInput, type EvaluatorConfig } from './evaluator.js';

const input = createInterface({ input: process.stdin });
input.once('line', (line) => {
  try {
    const request = JSON.parse(line) as { input: EvaluationInput; config?: EvaluatorConfig };
    process.stdout.write(JSON.stringify({ result: evaluateReplay(request.input, request.config) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
    process.exitCode = 1;
  } finally {
    input.close();
  }
});