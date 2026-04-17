#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from typing import Any


REGION = "ap-northeast-1"
TARGET_ALLOC_IDS = [
    "eipalloc-050ee3ddba3f389d0",
    "eipalloc-09afddc9b951edf10",
    "eipalloc-0af13d1632793ac35",
    "eipalloc-01ceb4b033be696fd",
]


@dataclass
class Result:
    allocation_id: str
    public_ip: str
    action: str
    reason: str
    details: str


def run_aws(args: list[str]) -> Any:
    cmd = ["aws", *args, "--output", "json"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{proc.stderr.strip()}")
    if not proc.stdout.strip():
        return {}
    return json.loads(proc.stdout)


def try_run_aws(args: list[str]) -> tuple[bool, Any]:
    try:
        return True, run_aws(args)
    except Exception as e:
        return False, str(e)


def classify_and_act(addr: dict[str, Any]) -> Result:
    alloc_id = addr.get("AllocationId", "-")
    public_ip = addr.get("PublicIp", "-")
    assoc_id = addr.get("AssociationId")
    eni_id = addr.get("NetworkInterfaceId")
    instance_id = addr.get("InstanceId")

    # 1) 未関連付けは即放出対象
    if not assoc_id:
        ok, resp = try_run_aws(["ec2", "release-address", "--region", REGION, "--allocation-id", alloc_id])
        if ok:
            return Result(alloc_id, public_ip, "RELEASED", "AssociationId が無く未紐付け", "")
        return Result(alloc_id, public_ip, "KEEP", "未紐付けだが release 失敗", str(resp))

    # 2) EC2 直結は保持
    if instance_id:
        return Result(alloc_id, public_ip, "KEEP", "EC2 インスタンスに紐付け", f"instance={instance_id}")

    # 3) NAT まだ生存していれば保持
    ok_nat, nat_data = try_run_aws(
        [
            "ec2",
            "describe-nat-gateways",
            "--region",
            REGION,
            "--filter",
            f"Name=nat-gateway-addresses.allocation-id,Values={alloc_id}",
        ]
    )
    if ok_nat:
        ngws = nat_data.get("NatGateways", [])
        alive = [n for n in ngws if n.get("State") not in ("deleted", "failed")]
        if alive:
            nat_ids = ",".join(n.get("NatGatewayId", "-") for n in alive)
            return Result(alloc_id, public_ip, "KEEP", "NAT Gateway が現存", f"nat={nat_ids}")

    # 4) ENI を見て ALB/EC2/RDS を強制保持
    if eni_id:
        ok_eni, eni_data = try_run_aws(
            ["ec2", "describe-network-interfaces", "--region", REGION, "--network-interface-ids", eni_id]
        )
        if not ok_eni:
            return Result(alloc_id, public_ip, "KEEP", "ENI 参照失敗のため安全側で保持", str(eni_data))

        nis = eni_data.get("NetworkInterfaces", [])
        if not nis:
            # ENI 消失済みなら残骸とみなし放出を試す
            ok_rel, rel = try_run_aws(["ec2", "release-address", "--region", REGION, "--allocation-id", alloc_id])
            if ok_rel:
                return Result(alloc_id, public_ip, "RELEASED", "ENI 消失済み（残骸）", "")
            return Result(alloc_id, public_ip, "KEEP", "ENI 消失済みだが release 失敗", str(rel))

        ni = nis[0]
        desc = str(ni.get("Description", ""))
        desc_l = desc.lower()
        attach = ni.get("Attachment") or {}
        ni_instance = attach.get("InstanceId")
        requester_managed = bool(ni.get("RequesterManaged"))
        status = str(ni.get("Status", ""))

        if ni_instance:
            return Result(alloc_id, public_ip, "KEEP", "ENI が EC2 にアタッチ", f"eni={eni_id},instance={ni_instance}")
        if "elb " in desc_l or "app/" in desc_l or "net/" in desc_l:
            return Result(alloc_id, public_ip, "KEEP", "ALB/NLB 用 ENI", f"eni={eni_id},desc={desc}")
        if "rds" in desc_l:
            return Result(alloc_id, public_ip, "KEEP", "RDS 系 ENI", f"eni={eni_id},desc={desc}")

        # 5) NAT 残骸/孤立 ENI を安全に放出
        likely_stale = ("nat gateway" in desc_l) or (status == "available" and not requester_managed and not attach)
        if likely_stale:
            ok_dis, dis = try_run_aws(["ec2", "disassociate-address", "--region", REGION, "--association-id", assoc_id])
            if not ok_dis:
                return Result(alloc_id, public_ip, "KEEP", "残骸候補だが disassociate 失敗", str(dis))
            ok_rel, rel = try_run_aws(["ec2", "release-address", "--region", REGION, "--allocation-id", alloc_id])
            if ok_rel:
                return Result(alloc_id, public_ip, "RELEASED", "NAT 残骸/孤立 ENI を放出", f"eni={eni_id},desc={desc}")
            return Result(alloc_id, public_ip, "KEEP", "disassociate 後 release 失敗", str(rel))

        return Result(
            alloc_id,
            public_ip,
            "KEEP",
            "用途不明のため安全側で保持",
            f"eni={eni_id},status={status},requester_managed={requester_managed},desc={desc}",
        )

    return Result(alloc_id, public_ip, "KEEP", "関連情報不足のため保持", "")


def main() -> int:
    print("== 1) 認証確認 ==")
    ok_sts, sts = try_run_aws(["sts", "get-caller-identity"])
    if not ok_sts:
        print(f"[ERROR] aws sts get-caller-identity failed: {sts}")
        return 1
    print(json.dumps(sts, ensure_ascii=False, indent=2))

    print("\n== 2) Elastic IP の取得 ==")
    try:
        addrs = run_aws(
            ["ec2", "describe-addresses", "--region", REGION, "--allocation-ids", *TARGET_ALLOC_IDS]
        ).get("Addresses", [])
    except Exception as e:
        print(f"[ERROR] describe-addresses failed: {e}")
        return 1

    found_ids = {a.get("AllocationId") for a in addrs}
    missing = [aid for aid in TARGET_ALLOC_IDS if aid not in found_ids]
    if missing:
        print(f"[WARN] 次の AllocationId は見つかりませんでした: {', '.join(missing)}")

    print("\n== 3-4) 依存関係チェックと安全な放出 ==")
    results: list[Result] = []
    for addr in addrs:
        res = classify_and_act(addr)
        results.append(res)
        print(f"- {res.allocation_id} ({res.public_ip}) => {res.action} / {res.reason}")
        if res.details:
            print(f"  details: {res.details}")

    print("\n== 結果一覧 ==")
    print("allocation_id | public_ip | action | reason")
    for r in results:
        print(f"{r.allocation_id} | {r.public_ip} | {r.action} | {r.reason}")

    return 0


if __name__ == "__main__":
    sys.exit(main())

