"""Flask web application for encryption/decryption."""
from flask import Flask, render_template, request, jsonify
from crypto.helm import HelmEncryptor
from crypto.ansible import AnsibleVaultEncryptor

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024  # 2MB max

helm = HelmEncryptor()
ansible = AnsibleVaultEncryptor()


def api_response(result=None, error=None, status=200):
    """Create standardized API response (DRY)."""
    if error:
        return jsonify({"error": str(error)}), status
    return jsonify({"result": result}), status


def validate_request(data, *fields):
    """Validate request data contains required fields (DRY)."""
    for field in fields:
        value = data.get(field, "") if data else ""
        if not value:
            return False, f"{field.capitalize()} is required"
    return True, None


@app.route("/")
def index():
    """Render main page."""
    return render_template("index.html")


@app.route("/validate", methods=["POST"])
def validate():
    """Validate text format (JSON/YAML)."""
    data = request.get_json()
    text = data.get("text", "") if data else ""

    if not text or not text.strip():
        return api_response(error="Text is required", status=400)

    # Normalise tab indentation — YAML forbids literal tabs as indentation.
    # Replace each leading tab with 2 spaces so pasted content from editors
    # validates correctly. JSON is unaffected (tabs are whitespace there).
    def _normalize_tabs(s):
        lines = s.split("\n")
        result = []
        for line in lines:
            # count leading tabs only, preserve tabs inside values
            stripped = line.lstrip("\t")
            tabs = len(line) - len(stripped)
            result.append("  " * tabs + stripped)
        return "\n".join(result)

    try:
        import json
        import yaml

        try:
            json.loads(text)
            return api_response({"valid": True, "format": "JSON"})
        except json.JSONDecodeError:
            pass

        try:
            yaml.safe_load(_normalize_tabs(text))
            return api_response({"valid": True, "format": "YAML"})
        except yaml.YAMLError as e:
            return api_response({"valid": False, "format": "Unknown", "error": str(e)})

    except ImportError:
        return api_response(error="Validation libraries not available", status=500)


@app.route("/helm/encrypt", methods=["POST"])
def helm_encrypt():
    """Encrypt text using Helm format."""
    valid, error = validate_request(request.get_json(), "text", "password")
    if not valid:
        return api_response(error=error, status=400)

    try:
        data = request.get_json()
        result = helm.encrypt(data["text"], data["password"])
        return api_response(result=result)
    except Exception as e:
        return api_response(error=str(e), status=500)


@app.route("/helm/decrypt", methods=["POST"])
def helm_decrypt():
    """Decrypt text using Helm format."""
    valid, error = validate_request(request.get_json(), "text", "password")
    if not valid:
        return api_response(error=error, status=400)

    try:
        data = request.get_json()
        result = helm.decrypt(data["text"], data["password"])
        return api_response(result=result)
    except Exception as e:
        return api_response(error=str(e), status=500)


@app.route("/ansible/encrypt", methods=["POST"])
def ansible_encrypt():
    """Encrypt text using Ansible Vault format."""
    valid, error = validate_request(request.get_json(), "text", "password")
    if not valid:
        return api_response(error=error, status=400)

    try:
        data = request.get_json()
        result = ansible.encrypt(data["text"], data["password"])
        return api_response(result=result)
    except Exception as e:
        return api_response(error=str(e), status=500)


@app.route("/ansible/decrypt", methods=["POST"])
def ansible_decrypt():
    """Decrypt text using Ansible Vault format."""
    valid, error = validate_request(request.get_json(), "text", "password")
    if not valid:
        return api_response(error=error, status=400)

    try:
        data = request.get_json()
        result = ansible.decrypt(data["text"], data["password"])
        return api_response(result=result)
    except Exception as e:
        return api_response(error=str(e), status=500)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
