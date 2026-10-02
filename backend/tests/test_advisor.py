from unittest.mock import Mock
import pytest
from bedrock_advisor import classify


def client_for(text, stop="end_turn"):
    c = Mock()
    c.converse.return_value = {"stopReason": stop, "output": {"message": {"content": [{"text": text}]}}}
    return c


@pytest.mark.parametrize("kind", ["cost_per_order", "success_rate", "missing_source"])
def test_validated_catalog_classification(kind):
    c = client_for('{"kind":"' + kind + '"}')
    assert classify("Business question", "configured-model", c) == kind
    assert c.converse.call_args.kwargs["inferenceConfig"]["maxTokens"] == 100


def test_arbitrary_model_expression_rejected():
    with pytest.raises(ValueError):
        classify("question", "model", client_for('{"kind":"exec_python","code":"delete"}'))


def test_model_refusal_not_treated_as_success():
    with pytest.raises(ValueError, match="complete"):
        classify("question", "model", client_for('{"kind":"cost_per_order"}', "guardrail_intervened"))


def test_provider_error_is_not_hidden():
    c = Mock()
    c.converse.side_effect = TimeoutError("provider timeout")
    with pytest.raises(TimeoutError):
        classify("question", "model", c)
