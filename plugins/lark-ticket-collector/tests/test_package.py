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

    def test_customer_service_followup_is_required_only_for_internal_followup(self) -> None:
        customer_service = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]
        unconditional = {
            field["field_key"]
            for field in customer_service["effective_required_fields"]
        }
        self.assertNotIn("field_234f83", unconditional)
        self.assertNotIn("下次跟进时间", customer_service["required_input"])
        conditional = {
            field["field_key"]: field
            for field in customer_service["conditional_required_fields"]
        }
        followup = conditional["field_234f83"]
        self.assertEqual(followup["field_name"], "下次跟进时间")
        self.assertEqual(
            followup["required_when"],
            {
                "field_key": "field_5e764e",
                "option_name": "内部跟进处理",
                "match_mode": "contains",
            },
        )
        self.assertEqual(
            followup["default_when_missing"],
            {
                "strategy": "message_create_date",
                "timezone": "Australia/Melbourne",
            },
        )

    def test_customer_service_defaults_to_three_stars(self) -> None:
        customer_service = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]
        policy = customer_service["level_default_policy"]
        self.assertEqual(policy["field_key"], customer_service["level_field"])
        self.assertEqual(policy["default_star_count"], 3)
        self.assertEqual(policy["default_option_name"], "🌟🌟🌟")
        self.assertEqual(policy["apply_when"], "not_explicitly_provided")
        self.assertTrue(policy["explicit_input_overrides"])
        self.assertTrue(policy["refresh_option_id_before_write"])

    def test_generic_merchant_evidence_routes_to_customer_service_first(self) -> None:
        customer_service = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]
        policy = customer_service["merchant_origin_default_routing"]
        self.assertTrue(policy["enabled"])
        self.assertTrue(policy["applies_when_request_is_generic_create"])
        self.assertEqual(policy["primary_work_item_type"], "customer_service")
        self.assertTrue(policy["explicit_type_request_overrides"])
        self.assertTrue(policy["never_route_directly_to_blocking_issue_from_abnormality_alone"])
        self.assertEqual(
            policy["blocking_abnormality_action"],
            "classify_customer_service_issue_as_t1_or_t2_then_apply_paired_blocking_issue_policy",
        )
        self.assertIn("企业微信", policy["merchant_origin_evidence"])
        self.assertEqual(policy["merchant_feedback_value_name"], "商家反馈")
        self.assertTrue(policy["omit_internal_discoverer"])

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

    def test_t1_t2_pairing_maps_external_feedback_without_internal_identity(self) -> None:
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
                "field_afbac9",
                "field_295507",
                "field_7ea900",
            },
        )
        self.assertNotIn("field_c21b7f", mapped)
        self.assertGreaterEqual(
            defaults,
            {"field_17627b", "field_22701f", "field_c1977f"},
        )
        self.assertNotIn("field_10c5ea", defaults)
        feedback = policy["feedback_type_policy"]
        self.assertEqual(feedback["external_customer_feedback_value_name"], "商家反馈")
        self.assertIn("企业微信", feedback["external_customer_source_names"])
        self.assertEqual(
            feedback["internal_discoverer"],
            {
                "field_key": "field_c21b7f",
                "field_name": "内部发现人",
                "source": "original_intake_sender",
                "required_when_feedback_type_name": "内部发现",
                "omit_when_feedback_type_name": "商家反馈",
            },
        )
        self.assertEqual(
            set(policy["must_resolve_without_placeholder"]),
            {
                "unique_customer_crm",
                "store_id",
                "terminal",
            },
        )
        self.assertEqual(
            policy["conditional_must_resolve_without_placeholder"],
            [
                {
                    "value": "original_sender_meegle_user",
                    "required_when_feedback_type_name": "内部发现",
                }
            ],
        )
        self.assertTrue(policy["partial_failure_policy"]["never_recreate_bundle"])

    def test_blocking_pairing_copies_verified_shared_fields_only_when_present(self) -> None:
        policy = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]["paired_blocking_issue_policy"]
        optional_copy = policy["optional_copy_policy"]
        self.assertTrue(optional_copy["copy_only_when_source_present"])
        self.assertTrue(optional_copy["empty_source_never_blocks_target_creation"])
        self.assertTrue(optional_copy["never_overwrite_explicit_target_value"])

        mapped = {
            field["target_field_key"]: field
            for field in policy["blocking_field_mapping"]
        }
        expected = {
            "description": "customer_service.description",
            "field_2c534f": "customer_service.field_20a3c6",
            "field_91fbb2": "customer_service.field_91fbb2",
        }
        for field_key, source in expected.items():
            self.assertEqual(mapped[field_key]["source"], source)
            self.assertEqual(mapped[field_key]["copy_mode"], "when_source_present")

    def test_blocking_issue_internal_discoverer_is_conditional(self) -> None:
        blocking = read_json("workspace/configuration/work-item-routing.json")["types"]["blocking_issue"]
        policy = blocking["feedback_type_policy"]
        self.assertEqual(policy["merchant_feedback_value_name"], "商家反馈")
        self.assertIn("企微群", policy["merchant_origin_evidence"])
        self.assertEqual(
            policy["internal_discoverer_field"]["required_only_when_feedback_type_name"],
            "内部发现",
        )
        self.assertEqual(policy["ambiguous_feedback_type_action"], "ask_user")

    def test_customer_service_business_pairings_target_only_authorized_types(self) -> None:
        routing = read_json("workspace/configuration/work-item-routing.json")
        customer_service = routing["types"]["customer_service"]
        policies = customer_service["paired_business_work_item_policies"]
        self.assertTrue(policies["enabled"])
        self.assertEqual(policies["trigger"]["field_key"], "field_5e764e")
        self.assertEqual(policies["trigger"]["match_mode"], "each_matching_option")
        self.assertEqual(
            {
                policy["trigger_option"]["option_name"]:
                policy["target_work_item_type"]["type_key"]
                for policy in policies["policies"].values()
            },
            {
                "T3客户代运营请求-内容维护": "67df87a8baf45c9c247ba778",
                "T5功能建议/改进类-需求": "67ee41797f03010701cea7c6",
                "客户刷卡机": "684b899ff9f859147aeca7dd",
                "风控处理": "6a7bbb6b50cf1f8304fedf79",
            },
        )
        paired_names = {
            policy["trigger_option"]["option_name"]
            for policy in policies["policies"].values()
        }
        self.assertTrue(
            {"T4商务类", "内部跟进处理", "客户情绪处理/公关危机"}.isdisjoint(
                paired_names
            )
        )
        self.assertFalse(policies["handoff_to_yoko"])
        gate = policies["paired_creation_gate"]
        self.assertTrue(gate["applies_to_all_authorized_policies"])
        self.assertTrue(
            gate["require_customer_service_and_all_matched_target_drafts_ready_before_any_create"]
        )
        self.assertTrue(gate["do_not_create_customer_service_only"])
        self.assertTrue(gate["external_api_writes_are_sequential_not_atomic"])
        self.assertFalse(
            policies["partial_failure_policy"][
                "allow_independent_ready_targets_to_continue_before_bundle_gate"
            ]
        )
        sequence = policies["write_sequence"]
        self.assertLess(
            sequence.index("enforce_shared_paired_creation_gate_or_stop_before_any_external_write"),
            sequence.index("create_and_verify_customer_service"),
        )
        self.assertTrue(
            policies["partial_failure_policy"]["resume_only_missing_steps"]
        )

    def test_customer_service_business_pairings_have_verified_bidirectional_relations(self) -> None:
        policies = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]["paired_business_work_item_policies"]["policies"]
        expected = {
            "t3_content_maintenance": ("field_e48264", "field_7e7ab1"),
            "t5_demand_pool": ("field_e5e3aa", "field_9fc721"),
            "customer_card_machine": ("field_baa8cb", "field_928eb4"),
            "risk_control": ("field_87d289", "field_4bf86b"),
        }
        for policy_key, field_keys in expected.items():
            relations = policies[policy_key]["relation_fields"]
            self.assertEqual(
                relations["customer_service_to_target"]["field_key"],
                field_keys[0],
            )
            self.assertEqual(
                relations["target_to_customer_service"]["field_key"],
                field_keys[1],
            )
            self.assertTrue(relations["refresh_before_write"])

    def test_all_green_pairings_are_gated_until_every_draft_is_ready(self) -> None:
        customer_service = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]
        blocking_gate = customer_service["paired_blocking_issue_policy"]["paired_creation_gate"]
        self.assertTrue(
            blocking_gate["require_customer_service_and_blocking_draft_ready_before_any_create"]
        )
        self.assertTrue(blocking_gate["do_not_create_customer_service_only"])
        self.assertTrue(blocking_gate["external_api_writes_are_sequential_not_atomic"])

        business = customer_service["paired_business_work_item_policies"]
        gate = business["paired_creation_gate"]
        self.assertTrue(
            gate["require_customer_service_and_all_matched_target_drafts_ready_before_any_create"]
        )
        self.assertTrue(gate["do_not_create_customer_service_only"])
        self.assertIn("every_matched_target", gate["completion_invariant"])
        self.assertEqual(
            set(business["policies"]),
            {
                "t3_content_maintenance",
                "t5_demand_pool",
                "customer_card_machine",
                "risk_control",
            },
        )

    def test_customer_card_machine_preserves_required_fields_under_shared_gate(self) -> None:
        card = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]["paired_business_work_item_policies"]["policies"]["customer_card_machine"]
        self.assertEqual(card["trigger_option"]["option_name"], "客户刷卡机")
        self.assertEqual(
            card["target_work_item_type"]["type_key"],
            "684b899ff9f859147aeca7dd",
        )
        mapped = {field["target_field_key"] for field in card["field_mapping"]}
        self.assertGreaterEqual(
            mapped,
            {
                "name",
                "description",
                "field_7bb02e",
                "field_928eb4",
                "field_9ef04c",
                "field_250a31",
                "field_73f715",
                "field_a9ddae",
                "field_490c5f",
            },
        )
        self.assertEqual(
            set(card["required_business_values"]),
            {
                "unique_customer_crm",
                "card_machine_points",
                "monthly_fee_choice",
                "card_machine_quantity",
            },
        )
        estimated_ready = next(
            field
            for field in card["field_mapping"]
            if field["target_field_key"] == "field_73f715"
        )
        self.assertEqual(
            estimated_ready["default_when_source_missing"],
            {
                "strategy": "message_create_date",
                "timezone": "Australia/Melbourne",
            },
        )
        self.assertTrue(card["inherits_shared_paired_creation_gate"])

    def test_all_new_work_item_schedule_fields_default_to_message_business_day(self) -> None:
        routing = read_json("workspace/configuration/work-item-routing.json")
        policy = routing["schedule_default_policy"]
        self.assertEqual(policy["scope"], "new_work_items_only")
        self.assertEqual(
            policy["precedence"],
            ["explicit_employee_value", "verified_copy_source", "message_business_day"],
        )
        self.assertEqual(policy["date_timezone"], "Australia/Melbourne")
        self.assertEqual(policy["default_precision"], "date")
        self.assertEqual(policy["manual_input_precision_required"], "date")
        self.assertTrue(policy["preserve_explicit_time_when_provided"])
        self.assertEqual(
            policy["serialization"],
            "preserve_calendar_date_using_live_field_and_project_timezone",
        )
        self.assertTrue(policy["exclude_historical_fact_dates"])
        self.assertTrue(policy["never_update_historical_work_items_implicitly"])

        readiness = read_json("workspace/configuration/workflow-readiness.json")
        self.assertEqual(
            readiness["generic_policy"]["value_policy"]["date_or_schedule"],
            "date_precision_explicit_then_verified_copy_then_default_to_message_business_day",
        )

        blocking = routing["types"]["customer_service"]["paired_blocking_issue_policy"]
        defaults = {
            field["target_field_key"]: field
            for field in blocking["authorized_defaults"]
        }
        self.assertEqual(defaults["field_22701f"]["value_source"], "single_submit_timestamp")
        self.assertEqual(defaults["field_c1977f"]["value_source"], "message_business_date")
        self.assertEqual(defaults["field_c1977f"]["precision"], "date")

    def test_customer_card_machine_catalog_keeps_verified_reverse_relation(self) -> None:
        catalog = read_json("workspace/configuration/work-item-catalog.json")
        card = next(item for item in catalog["types"] if item["slug"] == "customer_card_machine")
        relation = next(
            field for field in card["create_fields"]
            if field["field_key"] == "field_928eb4"
        )
        self.assertEqual(relation["field_name"], "关联客服工单")
        self.assertEqual(relation["related_type_key"], "6886d47112cff2ae4ae279e3")

    def test_content_pairing_maps_priority_and_requires_confirmation_and_producer(self) -> None:
        content = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]["paired_business_work_item_policies"]["policies"]["t3_content_maintenance"]
        mapped = {field["target_field_key"] for field in content["field_mapping"]}
        self.assertGreaterEqual(
            mapped,
            {"name", "description", "priority", "field_1e7f65", "field_7e7ab1", "field_581e1d"},
        )
        self.assertEqual(
            set(content["required_business_values"]),
            {
                "confirmation_required_boolean",
                "unique_customer_crm",
                "producer_role_owners_from_trusted_chat_name",
            },
        )
        self.assertEqual(
            {
                item["source_option_name"]: item["target_option_name"]
                for item in content["authorized_priority_mapping"]
            },
            {
                "🌟🌟🌟🌟": "Q0 阻断型立刻处理",
                "🌟🌟🌟": "Q1 紧急当日必交",
                "🌟🌟": "Q2 标准任务",
                "🌟": "Q3 非紧急任务",
            },
        )
        self.assertIn(
            "missing_confirmation_to_false", content["forbidden_inference"]
        )
        estimated_completion = next(
            field
            for field in content["field_mapping"]
            if field["target_field_key"] == "field_47cd28"
        )
        self.assertTrue(estimated_completion["explicit_target_value_precedence"])
        self.assertEqual(
            estimated_completion["default_when_source_missing"],
            {
                "strategy": "message_create_date",
                "timezone": "Australia/Melbourne",
            },
        )

    def test_business_pairings_copy_all_verified_shared_fields_conditionally(self) -> None:
        business = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]["paired_business_work_item_policies"]
        optional_copy = business["shared_optional_copy_policy"]
        self.assertTrue(optional_copy["copy_only_when_source_present"])
        self.assertTrue(optional_copy["empty_source_never_blocks_target_creation"])
        self.assertTrue(optional_copy["never_overwrite_explicit_target_value"])
        policies = business["policies"]

        expected = {
            "t3_content_maintenance": {
                "field_2398ed": "customer_service.field_20a3c6",
                "field_ce6397": "customer_service.field_4e18a5",
                "field_00ae6f": "customer_service.field_636ce3",
                "field_91fbb2": "customer_service.field_91fbb2",
                "field_47cd28": "customer_service.field_8c5e5f",
            },
            "t5_demand_pool": {
                "priority": "customer_service.priority",
            },
            "customer_card_machine": {
                "priority": "customer_service.priority",
            },
            "risk_control": {
                "description": "customer_service.description",
                "field_eb7afd": "general_risk_bundle_attachments",
            },
        }
        for policy_name, expected_fields in expected.items():
            mapped = {
                field["target_field_key"]: field
                for field in policies[policy_name]["field_mapping"]
            }
            for field_key, source in expected_fields.items():
                self.assertEqual(mapped[field_key]["source"], source)
                self.assertEqual(mapped[field_key]["copy_mode"], "when_source_present")

        self.assertIn(
            "customer_service_stars_to_demand_priority",
            policies["t5_demand_pool"]["forbidden_inference"],
        )

    def test_demand_and_risk_pairings_preserve_target_specific_requirements(self) -> None:
        policies = read_json("workspace/configuration/work-item-routing.json")["types"]["customer_service"]["paired_business_work_item_policies"]["policies"]
        demand = policies["t5_demand_pool"]
        self.assertEqual(
            {
                template["template_id_snapshot"]
                for key, template in demand["templates"].items()
                if key != "refresh_before_write"
            },
            {"2823040", "3012664", "3310913"},
        )
        self.assertIn(
            "customer_service_stars_to_demand_priority",
            demand["forbidden_inference"],
        )

        risk = policies["risk_control"]
        self.assertEqual(
            risk["required_create_role"]["role_name"],
            "当前处理的负责人",
        )
        self.assertTrue(risk["required_create_role"]["must_resolve_explicitly"])
        self.assertEqual(
            set(risk["chargeback_required_business_values"]),
            {
                "order_number",
                "chargeback_amount",
                "risk_source",
                "chargeback_reason",
                "mw_or_risk_notice_evidence",
                "current_handler",
            },
        )
        self.assertEqual(
            risk["workflow_readiness_profile"],
            "workspace/configuration/workflow-readiness.json#risk_control_chargeback",
        )

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
