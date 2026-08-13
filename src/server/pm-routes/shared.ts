import { BOARD_STATUSES, type BoardStatus } from "../../pm/types.js";

export const isStatus = (value: unknown): value is BoardStatus => BOARD_STATUSES.includes(value as BoardStatus);

export function notFound(reply: { code: (n: number) => void }, what: string): { error: string } {
  reply.code(404);
  return { error: `${what} not found` };
}
