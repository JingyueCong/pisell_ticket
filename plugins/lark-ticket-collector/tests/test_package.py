from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]


def read_json(relative_path: str) -> dict:
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


class PackageContractTests(unittest.TestCase):
    def test_plugin_and_collector_versions_match(self) -> None:
        plugin_version = read_json(".codex-plugin/plugin.json")["version"]
        skill_text = (ROOT / "skills/lark-ticket-collector/SKILL.md").read_text(
            encoding="utf-8"
        )
        match = re.search(r'(?m)^\s*version:\s*"([^"]+)"\s*$', skill_text)
        self.assertIsNotNone(match)
        self.assertEqual(plugin_version, match.group(1))

    def test_runtime_project_matches_snapshot(self) -> None:
        runtime = read_json("workspace/configuration/runtime.json")
        snapshot = read_json(
            "skills/lark-ticket-collector/references/pisell-intake-schema.snapshot.json"
        )
        self.assertEqual(
            runtime["project"]["simple_name"], snapshot["project"]["simple_name"]
        )
        self.assertEqual(
            runtime["project"]["host"], urlparse(snapshot["source_url"]).hostname
        )

    def test_policy_fields_exist_with_expected_types(self) -> None:
        snapshot = read_json(
            "skills/lark-ticket-collector/references/pisell-intake-schema.snapshot.json"
        )
        fields = {field["field_key"]: field for field in snapshot["fields"]}
        attachment = read_json(
            "workspace/configuration/attachment-description-policy-20260910.json"
        )
        historical = read_json(
            "workspace/configuration/historical-reference-policy-20260910.json"
        )
        self.assertEqual(
            fields[attachment["attachment_destination"]]["field_type"], "multi-file"
        )
        self.assertEqual(fields[historical["field_key"]]["field_type"], "multi-text")

    def test_cross_app_recipient_is_not_active(self) -> None:
        runtime = read_json("workspace/configuration/runtime.json")
        handoff = runtime["handoff"]
        self.assertTrue(handoff["resolve_member_per_sender_app"])
        self.assertIsNone(handoff["recipient_member_id"])
        self.assertEqual(handoff["chat_id_env"], "YOKO_HANDOFF_CHAT_ID")
        self.assertNotIn("chat_id", handoff)
        self.assertNotIn("legacy_open_id", handoff)
        self.assertNotIn("test_handoff_verification", runtime)

    def test_required_lark_scopes_cover_send_and_resolution(self) -> None:
        scopes = set(
            read_json("workspace/configuration/runtime.json")["required_lark_scopes"]
        )
        self.assertGreaterEqual(
            scopes,
            {"im:chat:read", "im:message:send_as_bot", "im:chat.members:read"},
        )

    def test_content_maintenance_producers_are_parsed_from_live_chat_name(self) -> None:
        runtime = read_json("workspace/configuration/runtime.json")
        source = runtime["content_maintenance"]["producer_role_source"]
        self.assertEqual(
            source["source_chat_id_env"], "CONTENT_PRODUCER_SOURCE_CHAT_ID"
        )
        self.assertEqual(source["read_mode"], "chat_name_only")
        self.assertTrue(source["refresh_chat_name_before_each_create"])
        self.assertTrue(source["refresh_role_metadata_before_write"])

        chat_name = "内部任务沟通9.28-9.30 制作：Annie/Jane 确认:Kiddy"
        match = re.search(source["extract_pattern"], chat_name)
        self.assertIsNotNone(match)
        producers = [
            name.strip()
            for name in re.split(source["name_split_pattern"], match.group(1))
            if name.strip()
        ]
        self.assertEqual(producers, ["Annie", "Jane"])

        catalog = read_json("workspace/configuration/work-item-catalog.json")
        content = next(
            item for item in catalog["types"] if item["slug"] == "content_maintenance"
        )
        self.assertEqual(
            {role["role_name"] for role in content["create_roles"]},
            {"制作人&交付人"},
        )

    def test_three_end_to_end_profiles_are_exact(self) -> None:
        routing = read_json("workspace/configuration/work-item-routing.json")
        type_keys = {item["type_key"] for item in routing["types"].values()}
        self.assertEqual(
            type_keys,
            {
                "67df88cf656f61b9b41455d3",
                "67ee41797f03010701cea7c6",
                "6886d47112cff2ae4ae279e3",
            },
        )

    def test_catalog_covers_all_pisell_work_item_types(self) -> None:
        catalog = read_json("workspace/configuration/work-item-catalog.json")
        types = catalog["types"]
        self.assertEqual(len(types), 22)
        self.assertEqual(len({item["slug"] for item in types}), 22)
        self.assertEqual(len({item["type_key"] for item in types}), 22)
        self.assertEqual(
            {item["type_key"] for item in types},
            {
                "story", "issue", "chart", "sub_task",
                "67c7c18727ecced1e59346bc", "67c7c75594cf49b77788a937",
                "67df84a32e42950cb0195cba", "67df857345c74ddf0fc97aa8",
                "67df87a8baf45c9c247ba778", "67df88cf656f61b9b41455d3",
                "67df890f3272196bad15643d", "67df8d3ebaa5f84f72d3395d",
                "67ee41797f03010701cea7c6", "67fc8713eb9d645203e30d89",
                "680844b6fa0cd90b9fcd38d7", "684b899ff9f859147aeca7dd",
                "6886d47112cff2ae4ae279e3", "688857874fce34fe209d37d9",
                "68a6f8d881ef81c327aaaef0", "69685e6e805973f19b5146d0",
                "6a0a717be4358c47e5807620", "6a7bbb6b50cf1f8304fedf79",
            },
        )

    def test_catalog_mode_counts_match_summary(self) -> None:
        catalog = read_json("workspace/configuration/work-item-catalog.json")
        types = catalog["types"]
        summary = catalog["summary"]
        active = [item for item in types if item["platform_status"] == "active"]
        disabled = [item for item in types if item["platform_status"] == "disabled"]
        standard = [item for item in types if item["support_mode"] == "standard_create"]
        specialized = [item for item in types if item["support_mode"].startswith("specialized_")]
        self.assertEqual(summary["total_types"], len(types))
        self.assertEqual(summary["active_types"], len(active))
        self.assertEqual(summary["disabled_types"], len(disabled))
        self.assertEqual(summary["standard_create_types"], len(standard))
        self.assertEqual(summary["specialized_active_types"], len(specialized))
        self.assertEqual(summary["create_e2e_verified_types"], 4)
        self.assertEqual(summary["ready_e2e_verified_types"], 0)
        self.assertEqual(summary["awaiting_node_input_verified_types"], 1)
        self.assertEqual((len(active), len(disabled), len(standard), len(specialized)), (18, 4, 16, 2))
        self.assertEqual({item["slug"] for item in specialized}, {"chart", "sub_task"})
        self.assertEqual(
            {item["slug"] for item in disabled},
            {"legacy_story", "legacy_issue", "xzero_platform", "pisell_os"},
        )

    def test_every_standard_create_type_has_name_template_and_templates(self) -> None:
        catalog = read_json("workspace/configuration/work-item-catalog.json")
        for item in catalog["types"]:
            if item["support_mode"] != "standard_create":
                continue
            self.assertTrue(item["templates"], item["slug"])
            if "create_fields_profile" in item:
                self.assertIn(item["slug"], {"blocking_issue", "demand_pool", "customer_service"})
                continue
            field_keys = {field["field_key"] for field in item["create_fields"]}
            self.assertGreaterEqual(field_keys, {"name", "template"}, item["slug"])

    def test_workflow_readiness_policy_applies_to_standard_types(self) -> None:
        catalog = read_json("workspace/configuration/work-item-catalog.json")
        readiness = read_json("workspace/configuration/workflow-readiness.json")
        self.assertEqual(
            catalog["workflow_readiness_profile"],
            "workspace/configuration/workflow-readiness.json",
        )
        self.assertEqual(
            readiness["generic_policy"]["applies_to_support_modes"],
            ["standard_create"],
        )
        self.assertTrue(readiness["generic_policy"]["post_create_readiness_check"])
        self.assertIn(
            "workflow list-state-required --mode unfinished 查询每个当前节点",
            readiness["generic_policy"]["required_sequence"],
        )
        self.assertEqual(
            {state["key"] for state in readiness["result_states"]},
            {
                "created",
                "create_verified",
                "awaiting_node_input",
                "ready_for_processing",
                "workflow_verified",
            },
        )

    def test_risk_control_profile_captures_hidden_role_and_initial_node(self) -> None:
        catalog = read_json("workspace/configuration/work-item-catalog.json")
        readiness = read_json("workspace/configuration/workflow-readiness.json")
        risk = next(item for item in catalog["types"] if item["slug"] == "risk_control")
        profile = readiness["profiles"]["risk_control_chargeback"]
        self.assertEqual(
            risk["readiness_profile"],
            "workspace/configuration/workflow-readiness.json#risk_control_chargeback",
        )
        self.assertEqual(profile["type_key"], risk["type_key"])
        self.assertEqual(profile["template_id"], "10178724")
        self.assertEqual(profile["validation_state"], "awaiting_node_input")
        self.assertEqual(
            {(role["role_key"], role["role_name"]) for role in profile["hidden_create_roles"]},
            {("role_b5881d", "当前处理的负责人")},
        )
        required = profile["initial_node"]["required_fields"]
        self.assertEqual(
            {field["field_key"] for field in required},
            {
                "field_be3477",
                "field_b63dba",
                "field_acc6ba",
                "field_e78ef8",
                "field_c1ea8e",
                "field_7905c9",
            },
        )
        self.assertTrue(all(field["update_via"] == "workitem update" for field in required))
        transaction = next(field for field in required if field["field_key"] == "field_b63dba")
        self.assertEqual(
            {option["option_name"] for option in transaction["options"]},
            {"已设置", "未设置（需要帮商家进行设置）"},
        )

    def test_catalog_validation_levels_do_not_overclaim_readiness(self) -> None:
        catalog = read_json("workspace/configuration/work-item-catalog.json")
        validated = [item for item in catalog["types"] if "validation" in item]
        self.assertEqual(len(validated), 4)
        self.assertTrue(all(item["validation"]["level"] == "create_e2e" for item in validated))
        self.assertFalse(any(item["validation"].get("readiness") == "ready_for_processing" for item in validated))

    def test_demand_pool_has_three_verified_templates(self) -> None:
        demand = read_json("workspace/configuration/work-item-routing.json")["types"]["demand_pool"]
        template_ids = {
            template["template_id"] for template in demand["templates"].values()
        }
        self.assertEqual(template_ids, {"2823040", "3012664", "3310913"})

    def test_customer_service_includes_hidden_followup_requirement(self) -> None:
        customer_service = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]
        required = {
            field["field_key"]: field
            for field in customer_service["effective_required_fields"]
        }
        self.assertEqual(required["field_234f83"]["field_name"], "下次跟进时间")
        self.assertTrue(
            required["field_234f83"]["source"].startswith(
                "create-api-ErrFieldRequired"
            )
        )

    def test_t1_t2_customer_service_links_or_creates_blocking_issue(self) -> None:
        routing = read_json("workspace/configuration/work-item-routing.json")
        customer_service = routing["types"]["customer_service"]
        blocking_issue = routing["types"]["blocking_issue"]
        policy = customer_service["paired_blocking_issue_policy"]

        self.assertTrue(policy["enabled"])
        self.assertEqual(policy["trigger"]["field_key"], "field_5e764e")
        self.assertEqual(
            {
                option["option_name"]: option["blocking_priority_name"]
                for option in policy["trigger"]["options"]
            },
            {
                "T1核心阻断性问题": "Lv1-紧急主流程中断",
                "T2非核心阻断性问题类流转升级": "Lv2-紧急核心高优先",
            },
        )
        self.assertEqual(
            policy["blocking_work_item_type"]["type_key"],
            blocking_issue["type_key"],
        )
        relations = policy["relation_fields"]
        self.assertEqual(
            relations["customer_service_to_blocking"]["field_key"],
            "field_d1511f",
        )
        self.assertEqual(
            relations["blocking_to_customer_service"]["field_key"],
            "field_295507",
        )

    def test_t1_t2_pairing_maps_required_blocking_fields_without_fabricating_identity(self) -> None:
        policy = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]["paired_blocking_issue_policy"]
        mapped = {
            field["target_field_key"]
            for field in policy["blocking_field_mapping"]
        }
        defaults = {
            field["target_field_key"]
            for field in policy["authorized_defaults"]
        }
        self.assertGreaterEqual(
            mapped,
            {
                "name",
                "field_ef7f33",
                "field_8318ee",
                "field_41737a",
                "field_c21b7f",
                "field_afbac9",
                "field_295507",
                "field_7ea900",
            },
        )
        self.assertGreaterEqual(
            defaults,
            {"field_17627b", "field_10c5ea", "field_22701f", "field_c1977f"},
        )
        self.assertEqual(
            set(policy["must_resolve_without_placeholder"]),
            {
                "unique_customer_crm",
                "store_id",
                "terminal",
                "original_sender_meegle_user",
            },
        )
        self.assertTrue(policy["partial_failure_policy"]["never_recreate_bundle"])

    def test_only_blocking_issues_are_handed_to_yoko(self) -> None:
        routing_types = read_json("workspace/configuration/work-item-routing.json")["types"]
        catalog_types = read_json("workspace/configuration/work-item-catalog.json")["types"]
        handoff = read_json("workspace/configuration/runtime.json")["handoff"]
        enabled = set(handoff["enabled_work_item_types"])
        expected = {
            item["type_key"]
            for item in catalog_types
            if item.get("handoff_to_yoko")
        }
        self.assertEqual(enabled, expected)
        self.assertEqual(enabled, {routing_types["blocking_issue"]["type_key"]})

    def test_each_special_profile_has_verified_online_test_evidence(self) -> None:
        routing_types = read_json("workspace/configuration/work-item-routing.json")["types"]
        for item in routing_types.values():
            self.assertRegex(item["verified_test_work_item_id"], r"^\d+$")
            self.assertRegex(item["verified_template_version"], r"^\d+$")


if __name__ == "__main__":
    unittest.main()
