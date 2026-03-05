"""
Unit tests for scripts/ado_sprint_setup.py

Covers all pure/logic functions without making real HTTP calls.
"""

import json
import os
import sys
import tempfile
from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest
import yaml

# Add scripts/ to path so we can import the module directly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import ado_sprint_setup as sut  # system under test


# ── Date helpers ──────────────────────────────────────────────────────────────

class TestCalculateSprintDates:
    def test_default_duration(self):
        start, end = sut.calculate_sprint_dates(15)
        assert start == date.today()
        assert end == date.today() + timedelta(days=14)

    def test_custom_duration(self):
        start, end = sut.calculate_sprint_dates(7)
        assert end == start + timedelta(days=6)

    def test_single_day_sprint(self):
        start, end = sut.calculate_sprint_dates(1)
        assert start == end


class TestBuildSprintName:
    def test_default_prefix(self):
        d = date(2026, 3, 5)
        assert sut.build_sprint_name("Sprint", d) == "Sprint 2026-03-05"

    def test_custom_prefix(self):
        d = date(2025, 12, 1)
        assert sut.build_sprint_name("ORES Sprint", d) == "ORES Sprint 2025-12-01"

    def test_zero_padded_dates(self):
        d = date(2026, 1, 9)
        assert sut.build_sprint_name("S", d) == "S 2026-01-09"


class TestFormatAdoDate:
    def test_adds_time_component(self):
        d = date(2026, 3, 5)
        assert sut.format_ado_date(d) == "2026-03-05T00:00:00Z"

    def test_year_boundary(self):
        d = date(2025, 12, 31)
        assert sut.format_ado_date(d) == "2025-12-31T00:00:00Z"


# ── Variable resolution ───────────────────────────────────────────────────────

class TestResolveVariables:
    VARS = {"client_name": "ORES", "fiscal_year": "FY25"}

    def test_string_substitution(self):
        result = sut._resolve_variables("{client_name} Upgrade {fiscal_year}", self.VARS)
        assert result == "ORES Upgrade FY25"

    def test_nested_dict(self):
        obj = {"title": "{client_name} {fiscal_year}", "priority": 2}
        result = sut._resolve_variables(obj, self.VARS)
        assert result["title"] == "ORES FY25"
        assert result["priority"] == 2   # non-string unchanged

    def test_list_of_strings(self):
        obj = ["{client_name}", "{fiscal_year}"]
        assert sut._resolve_variables(obj, self.VARS) == ["ORES", "FY25"]

    def test_unknown_variable_returns_original(self, capsys):
        result = sut._resolve_variables("{unknown_var}", self.VARS)
        assert result == "{unknown_var}"
        captured = capsys.readouterr()
        assert "WARNING" in captured.err

    def test_non_string_scalars_unchanged(self):
        assert sut._resolve_variables(42, self.VARS) == 42
        assert sut._resolve_variables(True, self.VARS) is True
        assert sut._resolve_variables(None, self.VARS) is None


# ── build_patch_document ──────────────────────────────────────────────────────

class TestBuildPatchDocument:
    ORG = "contoso"
    PROJECT = "MyProject"

    def _ops_by_path(self, ops):
        return {op["path"]: op["value"] for op in ops}

    def test_title_field_mapped(self):
        ops = sut.build_patch_document({"title": "My Epic"}, None, self.ORG, self.PROJECT)
        paths = self._ops_by_path(ops)
        assert paths[f"/fields/{sut.FIELD_TITLE}"] == "My Epic"

    def test_empty_fields_excluded(self):
        ops = sut.build_patch_document({"title": "T", "description": ""}, None, self.ORG, self.PROJECT)
        paths = self._ops_by_path(ops)
        assert f"/fields/{sut.FIELD_DESCRIPTION}" not in paths

    def test_none_fields_excluded(self):
        ops = sut.build_patch_document({"story_points": None}, None, self.ORG, self.PROJECT)
        assert not any(sut.FIELD_STORY_POINTS in op["path"] for op in ops)

    def test_parent_relation_added(self):
        ops = sut.build_patch_document({"title": "Story"}, 999, self.ORG, self.PROJECT)
        rel_ops = [op for op in ops if op["path"] == "/relations/-"]
        assert len(rel_ops) == 1
        assert str(999) in rel_ops[0]["value"]["url"]
        assert rel_ops[0]["value"]["rel"] == sut.RELATION_PARENT

    def test_no_parent_relation_when_none(self):
        ops = sut.build_patch_document({"title": "Epic"}, None, self.ORG, self.PROJECT)
        assert not any(op["path"] == "/relations/-" for op in ops)

    def test_all_fields_mapped(self):
        fields = {
            "title": "T",
            "description": "D",
            "tags": "tag1, tag2",
            "area_path": "Project\\Area",
            "iteration_path": "Project\\Sprint",
            "story_points": 5,
            "priority": 2,
            "acceptance_criteria": "Given...",
        }
        ops = sut.build_patch_document(fields, None, self.ORG, self.PROJECT)
        paths = {op["path"] for op in ops}
        for field_ref in [
            sut.FIELD_TITLE, sut.FIELD_DESCRIPTION, sut.FIELD_TAGS,
            sut.FIELD_AREA_PATH, sut.FIELD_ITERATION_PATH,
            sut.FIELD_STORY_POINTS, sut.FIELD_PRIORITY, sut.FIELD_ACCEPTANCE_CRITERIA,
        ]:
            assert f"/fields/{field_ref}" in paths


# ── load_config ───────────────────────────────────────────────────────────────

class TestLoadConfig:
    REQUIRED_VARS = {
        "ADO_PAT": "mytoken",
        "ADO_ORG": "contoso",
        "ADO_PROJECT": "MyProject",
        "ADO_TEAM": "MyProject Team",
        "TEMPLATE_PATH": "templates/work_items.yaml",
    }

    def test_valid_env_returns_config(self):
        with patch.dict(os.environ, self.REQUIRED_VARS, clear=False):
            config = sut.load_config()
        assert config["pat"] == "mytoken"
        assert config["org"] == "contoso"
        assert config["project"] == "MyProject"
        assert config["team"] == "MyProject Team"
        assert config["template_path"] == "templates/work_items.yaml"

    def test_missing_vars_exits_with_1(self):
        env_without = {k: v for k, v in self.REQUIRED_VARS.items() if k != "ADO_PAT"}
        with patch.dict(os.environ, env_without, clear=True):
            with pytest.raises(SystemExit) as exc_info:
                sut.load_config()
        assert exc_info.value.code == 1

    def test_all_missing_exits_with_1(self):
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(SystemExit) as exc_info:
                sut.load_config()
        assert exc_info.value.code == 1


# ── load_template ─────────────────────────────────────────────────────────────

MINIMAL_TEMPLATE = {
    "variables": {"client_name": "ORES", "fiscal_year": "FY25"},
    "sprints": {"name_prefix": "{client_name} Sprint", "duration_days": 15},
    "epics": [{"title": "{client_name} Upgrade {fiscal_year}"}],
}


class TestLoadTemplate:
    def _write_yaml(self, data) -> str:
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".yaml", delete=False, encoding="utf-8"
        )
        yaml.dump(data, tmp)
        tmp.close()
        return tmp.name

    def test_loads_and_resolves_variables(self):
        path = self._write_yaml(MINIMAL_TEMPLATE)
        try:
            with patch.dict(os.environ, {}, clear=False):
                result = sut.load_template(path)
            assert result["epics"][0]["title"] == "ORES Upgrade FY25"
        finally:
            os.unlink(path)

    def test_env_var_overrides_yaml_default(self):
        path = self._write_yaml(MINIMAL_TEMPLATE)
        try:
            with patch.dict(os.environ, {"CLIENT_NAME": "Acme", "FISCAL_YEAR": "FY26"}, clear=False):
                result = sut.load_template(path)
            assert result["epics"][0]["title"] == "Acme Upgrade FY26"
        finally:
            os.unlink(path)

    def test_missing_file_exits_with_3(self):
        with pytest.raises(SystemExit) as exc_info:
            sut.load_template("/nonexistent/path/file.yaml")
        assert exc_info.value.code == 3

    def test_invalid_yaml_exits_with_3(self):
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".yaml", delete=False, encoding="utf-8"
        )
        tmp.write(": invalid: yaml: [\n")
        tmp.close()
        try:
            with pytest.raises(SystemExit) as exc_info:
                sut.load_template(tmp.name)
            assert exc_info.value.code == 3
        finally:
            os.unlink(tmp.name)

    def test_missing_epics_key_exits_with_3(self):
        path = self._write_yaml({"variables": {}, "sprints": {}})
        try:
            with pytest.raises(SystemExit) as exc_info:
                sut.load_template(path)
            assert exc_info.value.code == 3
        finally:
            os.unlink(path)
