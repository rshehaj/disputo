# DeepEval runner for the disputo agent. Build context is the repository root:
#   docker build -f evals/Dockerfile .
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DEEPEVAL_TELEMETRY_OPT_OUT=YES
WORKDIR /app
COPY evals/requirements.txt evals/requirements.txt
RUN pip install --no-cache-dir --root-user-action=ignore -r evals/requirements.txt
COPY evals/ evals/
RUN useradd --create-home eval && mkdir -p evals/runs && chown -R eval:eval /app
USER eval
CMD ["deepeval", "test", "run", "evals/test_agent.py"]
