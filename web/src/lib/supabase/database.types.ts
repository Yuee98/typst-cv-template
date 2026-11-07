export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      cv_document_contents: {
        Row: {
          data: Json | null
          document_schema_version: number | null
          encrypted_payload: Json | null
          external_id: string | null
          revision: string | null
          storage_mode: string | null
          time_created: string | null
          time_updated: string | null
          title: string | null
        }
        Insert: {
          data?: Json | null
          document_schema_version?: number | null
          encrypted_payload?: Json | null
          external_id?: string | null
          revision?: never
          storage_mode?: string | null
          time_created?: string | null
          time_updated?: string | null
          title?: string | null
        }
        Update: {
          data?: Json | null
          document_schema_version?: number | null
          encrypted_payload?: Json | null
          external_id?: string | null
          revision?: never
          storage_mode?: string | null
          time_created?: string | null
          time_updated?: string | null
          title?: string | null
        }
        Relationships: []
      }
      cv_document_summaries: {
        Row: {
          document_schema_version: number | null
          external_id: string | null
          revision: string | null
          storage_mode: string | null
          time_created: string | null
          time_updated: string | null
          title: string | null
        }
        Insert: {
          document_schema_version?: number | null
          external_id?: string | null
          revision?: never
          storage_mode?: string | null
          time_created?: string | null
          time_updated?: string | null
          title?: string | null
        }
        Update: {
          document_schema_version?: number | null
          external_id?: string | null
          revision?: never
          storage_mode?: string | null
          time_created?: string | null
          time_updated?: string | null
          title?: string | null
        }
        Relationships: []
      }
      legal_my_acceptances: {
        Row: {
          accepted_content_digest: string | null
          disclosure_id: string | null
          document_version_id: string | null
          time_accepted: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      admin_ai_disable: { Args: { p_input: Json }; Returns: Json }
      admin_ai_reopen: { Args: { p_input: Json }; Returns: Json }
      admin_ai_set_allowed_user: { Args: { p_input: Json }; Returns: Json }
      admin_ai_set_audience: { Args: { p_input: Json }; Returns: Json }
      admin_ai_set_policy: { Args: { p_input: Json }; Returns: Json }
      admin_ai_update_limits: { Args: { p_input: Json }; Returns: Json }
      admin_analytics: { Args: { p_days?: number }; Returns: Json }
      admin_context: { Args: never; Returns: Json }
      admin_member_grant: { Args: { p_input: Json }; Returns: Json }
      admin_member_revoke: { Args: { p_input: Json }; Returns: Json }
      admin_policy_create: { Args: { p_input: Json }; Returns: Json }
      admin_policy_retire: { Args: { p_input: Json }; Returns: Json }
      admin_policy_version_create: { Args: { p_input: Json }; Returns: Json }
      admin_policy_version_publish: { Args: { p_input: Json }; Returns: Json }
      admin_policy_version_retire: { Args: { p_input: Json }; Returns: Json }
      admin_price_version_close: { Args: { p_input: Json }; Returns: Json }
      admin_price_version_create: { Args: { p_input: Json }; Returns: Json }
      admin_price_version_publish: { Args: { p_input: Json }; Returns: Json }
      admin_price_version_replace: { Args: { p_input: Json }; Returns: Json }
      admin_price_version_retire: { Args: { p_input: Json }; Returns: Json }
      admin_profile_create: { Args: { p_input: Json }; Returns: Json }
      admin_profile_retire: { Args: { p_input: Json }; Returns: Json }
      admin_profile_version_create: { Args: { p_input: Json }; Returns: Json }
      admin_profile_version_publish: { Args: { p_input: Json }; Returns: Json }
      admin_profile_version_retire: { Args: { p_input: Json }; Returns: Json }
      admin_provider_update: { Args: { p_input: Json }; Returns: Json }
      admin_read: { Args: { p_input: Json }; Returns: Json }
      admin_record: {
        Args: { p_external_id: string; p_kind: string }
        Returns: Json
      }
      admin_records: {
        Args: { p_after?: string; p_kind: string; p_limit?: number }
        Returns: Json
      }
      ai_attempt_complete: { Args: { p_input: Json }; Returns: Json }
      ai_attempt_start: { Args: { p_input: Json }; Returns: Json }
      ai_availability: { Args: { p_input: Json }; Returns: Json }
      ai_cancel: { Args: { p_input: Json }; Returns: Json }
      ai_execution_snapshot: { Args: { p_input: Json }; Returns: Json }
      ai_finalize: { Args: { p_input: Json }; Returns: Json }
      ai_quota: { Args: { p_input: Json }; Returns: Json }
      ai_reserve: { Args: { p_input: Json }; Returns: Json }
      app_context: { Args: never; Returns: Json }
      config_validation_candidate: { Args: { p_input: Json }; Returns: Json }
      config_validation_record: { Args: { p_input: Json }; Returns: Json }
      cv_document_convert: { Args: { p_input: Json }; Returns: Json }
      cv_document_create: { Args: { p_input: Json }; Returns: Json }
      cv_document_delete: { Args: { p_input: Json }; Returns: Json }
      cv_document_rename: { Args: { p_input: Json }; Returns: Json }
      cv_document_update: { Args: { p_input: Json }; Returns: Json }
      keep_project_active: { Args: never; Returns: boolean }
      legal_accept_disclosure: { Args: { p_input: Json }; Returns: Json }
      legal_accept_document: { Args: { p_input: Json }; Returns: Json }
      legal_current: { Args: never; Returns: Json }
      runtime_readback_candidate: { Args: { p_input: Json }; Returns: Json }
      runtime_readback_record: { Args: { p_input: Json }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

