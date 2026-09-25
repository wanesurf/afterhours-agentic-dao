import test from "node:test";
import assert from "node:assert/strict";
import { AFTERHOURS_DAO, readDaoStatus } from "../packages/dao-client/src/deployed-dao.js";

function account(owner: string) {
  return { owner, executable: false, data: ["AQ==", "base64"] };
}

test("DAO read verifies finalized realm, governance, and both mint owners", async () => {
  const calls: RequestInit[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(init || {});
    return Response.json({ result: { context: { slot: 123 }, value: [
      account(AFTERHOURS_DAO.governanceProgram), account(AFTERHOURS_DAO.governanceProgram),
      account(AFTERHOURS_DAO.token2022Program), account(AFTERHOURS_DAO.splTokenProgram),
    ] } });
  };
  const status = await readDaoStatus("https://rpc.example", fetcher);
  assert.equal(status.verified, true);
  assert.equal(status.finalizedSlot, 123);
  const request = JSON.parse(String(calls[0]!.body));
  assert.equal(request.method, "getMultipleAccounts");
  assert.equal(request.params[1].commitment, "finalized");
  assert.deepEqual(request.params[0], [AFTERHOURS_DAO.realm, AFTERHOURS_DAO.governance,
    AFTERHOURS_DAO.communityMint, AFTERHOURS_DAO.councilMint]);
});

test("DAO read reports an owner mismatch without claiming verification", async () => {
  const fetcher: typeof fetch = async () => Response.json({ result: { context: { slot: 124 }, value: [
    account(AFTERHOURS_DAO.governanceProgram), account(AFTERHOURS_DAO.governanceProgram),
    account(AFTERHOURS_DAO.splTokenProgram), account(AFTERHOURS_DAO.splTokenProgram),
  ] } });
  const status = await readDaoStatus("https://rpc.example", fetcher);
  assert.equal(status.verified, false);
  assert.equal(status.accounts[2]?.valid, false);
});
