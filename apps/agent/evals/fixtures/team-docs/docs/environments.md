# Environments

| Environment | Region    | Replicas      |
| ----------- | --------- | ------------- |
| development | eu-west-1 | 1             |
| staging     | eu-west-1 | at most 7     |
| production  | eu-west-1 | 12 by default |

Staging may never run more than 7 replicas, to keep its database within its connection limit.
