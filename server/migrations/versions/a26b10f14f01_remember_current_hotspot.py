"""Remember selected hotspot for follow-up questions without a tour workflow."""
from alembic import op
import sqlalchemy as sa

revision = "a26b10f14f01"
down_revision = "8b19e9e0146f"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("visitor_sessions", sa.Column("current_hotspot_id", sa.String(64), nullable=True))


def downgrade():
    with op.batch_alter_table("visitor_sessions") as batch:
        batch.drop_column("current_hotspot_id")
