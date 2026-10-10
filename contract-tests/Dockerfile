FROM python:3.12-slim
WORKDIR /kit
COPY contract-tests/requirements.txt contract-tests/requirements.txt
RUN pip install --no-cache-dir -r contract-tests/requirements.txt
COPY contract/ contract/
COPY contract-tests/ contract-tests/
COPY data/ data/
ENTRYPOINT ["python", "contract-tests/run_tests.py", "--broker", "redpanda:9092"]
