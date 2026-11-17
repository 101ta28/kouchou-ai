import json

from analysis_core.audit import AuditStore
from analysis_core.orchestrator import PipelineOrchestrator
from analysis_core.plugin import PluginRegistry, StepOutputs, step_plugin
from analysis_core.public_result import write_result_files
from analysis_core.workflow import WorkflowDefinition, WorkflowEngine, WorkflowStep


def test_success_reuse_failure_and_rerun_preserve_actual_evidence(tmp_path, monkeypatch):
    """Exercise the real workflow engine/status writer with deterministic local plugins."""
    inputs = tmp_path / "inputs"
    outputs = tmp_path / "outputs"
    inputs.mkdir()
    (inputs / "report.csv").write_text("comment-id,comment-body\nc1,バスを増やしてほしい\n")
    registry = PluginRegistry()

    @step_plugin(id="test.audit-extract", version="1.0", inputs=["comments"], outputs=["arguments", "relations"])
    def extract(ctx, step_inputs, config):
        assert "バスを増やしてほしい" in step_inputs.artifacts["comments"].read_text()
        args = ctx.output_dir / "args.csv"
        relations = ctx.output_dir / "relations.csv"
        args.write_text("arg-id,argument\nA1,バスを増やしてほしい\n")
        relations.write_text("arg-id,comment-id\nA1,c1\n")
        return StepOutputs(artifacts={"arguments": args, "relations": relations}, token_usage=10)

    @step_plugin(id="test.audit-overview", version="2.0", inputs=["arguments"], outputs=["result", "public_result"])
    def overview(ctx, step_inputs, config):
        if config["prompt"] == "fail":
            raise RuntimeError("simulated provider failure")
        result_path = ctx.output_dir / "hierarchical_result.json"
        write_result_files(result_path, {"overview": config["prompt"], "config": step_inputs.config})
        return StepOutputs(
            artifacts={"result": result_path, "public_result": result_path.with_name("public_result.json")}
        )

    registry.register(extract)
    registry.register(overview)
    workflow = WorkflowDefinition(
        id="test-audit",
        version="1",
        steps=[
            WorkflowStep(id="extraction", plugin="test.audit-extract"),
            WorkflowStep(
                id="overview",
                plugin="test.audit-overview",
                depends_on=["extraction"],
                config={"prompt": "${config.hierarchical_overview.prompt}"},
            ),
        ],
    )
    monkeypatch.setattr("analysis_core.workflows.get_workflow_for_mode", lambda mode: workflow)
    monkeypatch.setattr("analysis_core.workflow.WorkflowEngine", lambda: WorkflowEngine(registry))

    def run(prompt, extraction=True):
        orchestrator = PipelineOrchestrator.from_dict(
            {
                "input": "report",
                "name": "report",
                "question": "Q",
                "provider": "local",
                "model": "local-alias",
                "hierarchical_overview": {"prompt": prompt},
                "plan": [{"step": "extraction", "run": extraction}, {"step": "hierarchical_overview", "run": True}],
            },
            output_base_dir=outputs,
            input_base_dir=inputs,
        )
        return orchestrator.run_default()

    assert run("first").success
    store = AuditStore(outputs / "report")
    first = store.list_records()[0]
    first_manifest = store.file(first["run_id"], "manifest.json").read_bytes()
    assert not run("fail", extraction=False).success
    failed = store.list_records()[0]
    assert failed["status"] == "failed"
    skipped = next(step for step in failed["steps"] if step["step"] == "extraction" and step["status"] == "skipped")
    assert skipped["reused_job"]["audit_run_id"] == first["run_id"]
    assert run("third", extraction=False).success
    third = store.list_records()[0]
    assert third["parent_run_id"] == failed["run_id"]
    assert store.file(first["run_id"], "manifest.json").read_bytes() == first_manifest
    assert json.loads(store.file(first["run_id"], "after/public_result.json").read_text())["overview"] == "first"
    assert json.loads(store.file(third["run_id"], "after/public_result.json").read_text())["overview"] == "third"
    assert "_audit_run_id" not in json.loads((outputs / "report/public_result.json").read_text())["config"]
    assert all(store.verify(record["run_id"])["valid"] for record in store.list_records())
    resolved = next(step for step in third["steps"] if step["status"] == "resolved" and step["step"] == "overview")
    assert resolved["plugin_version"] == "2.0"
    assert resolved["params"]["prompt"] == "third"
